//! 天气。双源回退：Open-Meteo 优先，不通就换 wttr.in。
//!
//! v0.1 实测 Open-Meteo 在这台机器的网络上超时，而 wttr.in 可达，
//! 所以两条链路都要能用，不能只写一条。

use crate::config::Config;
use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize)]
pub struct Hour {
    pub label: String,
    pub temp: i32,
    pub icon: String,
    /// 这一格是不是明天。前端只在列上加一个点，不把「明」写进标签——
    /// 卡片最小宽度下一列只有 29px，多一个字就换行。
    pub tomorrow: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Weather {
    pub city: String,
    /// 省 · 市 · 区，前端做悬停提示
    pub admin: String,
    pub temp: i32,
    pub cond: String,
    pub icon: String,
    pub high: i32,
    pub low: i32,
    pub hours: Vec<Hour>,
    pub source: String,
}

static LATEST: Mutex<Option<Weather>> = Mutex::new(None);

pub fn latest() -> Option<Weather> {
    LATEST.lock().ok().and_then(|g| g.clone())
}

pub fn store(w: &Weather) {
    if let Ok(mut g) = LATEST.lock() {
        *g = Some(w.clone());
    }
}

/// WMO 天气代码 → (中文描述, 图标键)
fn wmo(code: u32) -> (&'static str, &'static str) {
    match code {
        0 => ("晴", "sun"),
        1 | 2 => ("多云", "partly"),
        3 => ("阴", "cloud"),
        45 | 48 => ("雾", "fog"),
        51..=57 => ("毛毛雨", "rain"),
        61 | 63 | 65 => ("雨", "rain"),
        66 | 67 => ("冻雨", "rain"),
        71 | 73 | 75 => ("雪", "snow"),
        77 => ("霰", "snow"),
        80..=82 => ("阵雨", "rain"),
        85 | 86 => ("阵雪", "snow"),
        95 => ("雷阵雨", "thunder"),
        96 | 99 => ("雷暴冰雹", "thunder"),
        _ => ("未知", "cloud"),
    }
}

/// wttr.in 的天气代码是另一套，按区间归类
fn wttr(code: u32) -> (&'static str, &'static str) {
    match code {
        113 => ("晴", "sun"),
        116 => ("多云", "partly"),
        119 | 122 => ("阴", "cloud"),
        143 | 248 | 260 => ("雾", "fog"),
        200 | 386 | 389 | 392 | 395 => ("雷阵雨", "thunder"),
        227 | 230 | 323..=338 | 368..=377 => ("雪", "snow"),
        _ => ("雨", "rain"),
    }
}

/// "2026-11-15T22:00" → "2026-11-15T22"，只保留到小时，用来对齐时次
fn hour_key(s: &str) -> Option<&str> {
    s.get(0..13)
}

async fn try_open_meteo(cfg: &Config) -> Option<Weather> {
    // forecast_days 必须是 2：只要 1 天的话，22 点以后 hourly 数组只剩 2 格，
    // 「未来 6 小时」会被截成「今天剩下的小时」。跨天是常态，不是边界情况。
    let url = format!(
        "https://api.open-meteo.com/v1/forecast?latitude={}&longitude={}\
         &current=temperature_2m,weather_code\
         &hourly=temperature_2m,weather_code\
         &daily=temperature_2m_max,temperature_2m_min\
         &forecast_days=2&timezone=auto",
        cfg.weather.lat, cfg.weather.lon
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .build()
        .ok()?;
    let v: serde_json::Value = client.get(url).send().await.ok()?.json().await.ok()?;

    let code = v.pointer("/current/weather_code")?.as_u64()? as u32;
    let temp = v.pointer("/current/temperature_2m")?.as_f64()?;
    let (cond, icon) = wmo(code);

    let high = v.pointer("/daily/temperature_2m_max/0")?.as_f64()?;
    let low = v.pointer("/daily/temperature_2m_min/0")?.as_f64()?;

    let mut hours = Vec::new();
    if let Some(arr) = v.pointer("/hourly/time").and_then(|a| a.as_array()) {
        let temps = v
            .pointer("/hourly/temperature_2m")
            .and_then(|a| a.as_array())
            .cloned()
            .unwrap_or_default();
        let codes = v
            .pointer("/hourly/weather_code")
            .and_then(|a| a.as_array())
            .cloned()
            .unwrap_or_default();
        // 「当前小时」以接口返回的 current.time 为准（timezone=auto，就是当地时刻），
        // 这样跨时区、跨夏令时都不用本地钟去猜。
        let now = v
            .pointer("/current/time")
            .and_then(|x| x.as_str())
            .unwrap_or_default();
        let now_key = hour_key(now);
        let today = now.get(0..10);

        let start = arr
            .iter()
            .position(|t| {
                let s = t.as_str().unwrap_or_default();
                match (hour_key(s), now_key) {
                    (Some(a), Some(b)) => a == b,
                    _ => false,
                }
            })
            .unwrap_or(0);

        for i in start..(start + 6).min(arr.len()) {
            let raw = arr.get(i).and_then(|t| t.as_str()).unwrap_or_default();
            let hh = raw.get(11..13).unwrap_or("--");
            let t = temps.get(i).and_then(|x| x.as_f64()).unwrap_or(0.0);
            let c = codes.get(i).and_then(|x| x.as_u64()).unwrap_or(3) as u32;
            hours.push(Hour {
                label: format!("{hh}时"),
                temp: t.round() as i32,
                icon: wmo(c).1.to_string(),
                tomorrow: raw.get(0..10).is_some() && raw.get(0..10) != today,
            });
        }
    }

    Some(Weather {
        city: cfg.weather.city.clone(),
        admin: cfg.weather.admin.clone(),
        temp: temp.round() as i32,
        cond: cond.into(),
        icon: icon.into(),
        high: high.round() as i32,
        low: low.round() as i32,
        hours,
        source: "open-meteo".into(),
    })
}

/// 本地时刻（当天已过的分钟数），避免 extra 依赖。
/// 时区按 UTC+8 兜底——项目面向中文用户，且这条只在 wttr 兜底链路里用到。
fn local_minutes_now() -> u32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    (((secs + 8 * 3600) % 86400) / 60) as u32
}

async fn try_wttr(cfg: &Config) -> Option<Weather> {
    let url = format!(
        "https://wttr.in/{},{}?format=j1&lang=zh",
        cfg.weather.lat, cfg.weather.lon
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .ok()?;
    let v: serde_json::Value = client.get(url).send().await.ok()?.json().await.ok()?;

    let cur = v.pointer("/current_condition/0")?;
    let temp: i32 = cur.get("temp_C")?.as_str()?.parse().ok()?;
    let code: u32 = cur.get("weatherCode")?.as_str()?.parse().ok()?;
    let (cond, icon) = wttr(code);
    let desc = cur
        .pointer("/lang_zh/0/value")
        .or_else(|| cur.pointer("/weatherDesc/0/value"))
        .and_then(|x| x.as_str())
        .unwrap_or(cond)
        .to_string();

    // wttr 给的是 3 小时一档、连续 3 天。以前只看第一天、从第二条开始取 6 条，
    // 22 点以后既跨不了天，也取不到「未来」；这里拉平三天按绝对时刻筛。
    let mut hours = Vec::new();
    let now_min = local_minutes_now();
    if let Some(days) = v.get("weather").and_then(|w| w.as_array()) {
        let mut picked = 0;
        for (d, day) in days.iter().enumerate() {
            if picked >= 6 {
                break;
            }
            let Some(hs) = day.get("hourly").and_then(|h| h.as_array()) else {
                continue;
            };
            for h in hs {
                if picked >= 6 {
                    break;
                }
                let time = h.get("time").and_then(|t| t.as_str()).unwrap_or("0");
                let hh = (time.parse::<u32>().unwrap_or(0) / 100).min(23);
                let abs = d as u32 * 1440 + hh * 60;
                if abs < now_min {
                    continue;
                }
                let t = h
                    .get("tempC")
                    .and_then(|x| x.as_str())
                    .and_then(|s| s.parse::<i32>().ok())
                    .unwrap_or(0);
                let c = h
                    .get("weatherCode")
                    .and_then(|x| x.as_str())
                    .and_then(|s| s.parse::<u32>().ok())
                    .unwrap_or(119);
                hours.push(Hour {
                    label: format!("{hh}时"),
                    temp: t,
                    icon: wttr(c).1.to_string(),
                    tomorrow: d > 0,
                });
                picked += 1;
            }
        }
    }

    let high = v
        .pointer("/weather/0/maxtempC")
        .and_then(|x| x.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .map(|f| f.round() as i32)
        .unwrap_or(temp);
    let low = v
        .pointer("/weather/0/mintempC")
        .and_then(|x| x.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .map(|f| f.round() as i32)
        .unwrap_or(temp);

    Some(Weather {
        city: cfg.weather.city.clone(),
        admin: cfg.weather.admin.clone(),
        temp,
        cond: desc,
        icon: icon.into(),
        high,
        low,
        hours,
        source: "wttr.in".into(),
    })
}

pub async fn fetch(cfg: &Config) -> Option<Weather> {
    if let Some(w) = try_open_meteo(cfg).await {
        return Some(w);
    }
    try_wttr(cfg).await
}

/// 后台每 15 分钟刷新一次，首次立刻拉。
/// 每轮都从共享状态读配置，用户在设置里换了地区不必重启进程。
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let cfg = match app.try_state::<crate::state::AppState>() {
                Some(s) => s.config(),
                None => Config::default_for(1920.0, 1080.0),
            };
            let got = fetch(&cfg).await;
            match got {
                Some(w) => {
                    eprintln!("[weather] {} {}° 来源 {}", w.city, w.temp, w.source);
                    store(&w);
                    let _ = app.emit("weather", &w);
                }
                None => {
                    eprintln!("[weather] 两个源都失败");
                    let _ = app.emit("weather:error", ());
                }
            }
            tokio_sleep(Duration::from_secs(900)).await;
        }
    });
}

async fn tokio_sleep(d: Duration) {
    // 不额外引 tokio 依赖：用阻塞线程包一层足够，15 分钟一次的函数不值得优化
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}
