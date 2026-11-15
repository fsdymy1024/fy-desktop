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

async fn try_open_meteo(cfg: &Config) -> Option<Weather> {
    let url = format!(
        "https://api.open-meteo.com/v1/forecast?latitude={}&longitude={}\
         &current=temperature_2m,weather_code\
         &hourly=temperature_2m,weather_code\
         &daily=temperature_2m_max,temperature_2m_min\
         &forecast_days=1&timezone=auto",
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
        // 从「当前小时」往后取 6 个
        let now_hour = chrono_hour(arr);
        let start = arr
            .iter()
            .position(|t| {
                t.as_str()
                    .and_then(|s| s.get(11..13))
                    .and_then(|h| h.parse::<u32>().ok())
                    == Some(now_hour)
            })
            .unwrap_or(0);
        for i in start..(start + 6).min(arr.len()) {
            let label = arr
                .get(i)
                .and_then(|t| t.as_str())
                .and_then(|s| s.get(11..13))
                .map(|h| format!("{h}时"))
                .unwrap_or_default();
            let t = temps.get(i).and_then(|x| x.as_f64()).unwrap_or(0.0);
            let c = codes.get(i).and_then(|x| x.as_u64()).unwrap_or(3) as u32;
            hours.push(Hour {
                label,
                temp: t.round() as i32,
                icon: wmo(c).1.to_string(),
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

/// 本机当前小时，避免 extra 依赖，直接读系统时间
fn chrono_hour(_times: &[serde_json::Value]) -> u32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // 本地时区偏移由系统 TZ 决定；这里用 UTC + 8 兜底（项目面向中文用户）
    (((secs + 8 * 3600) % 86400) / 3600) as u32
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

    let mut hours = Vec::new();
    if let Some(arr) = v.get("weather").and_then(|w| w.as_array()) {
        if let Some(today) = arr.first() {
            if let Some(hs) = today.get("hourly").and_then(|h| h.as_array()) {
                for h in hs.iter().skip(1).take(6) {
                    let time = h.get("time").and_then(|t| t.as_str()).unwrap_or("0");
                    let label = format!("{}时", (time.parse::<u32>().unwrap_or(0) / 100).min(23));
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
                        label,
                        temp: t,
                        icon: wttr(c).1.to_string(),
                    });
                }
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
