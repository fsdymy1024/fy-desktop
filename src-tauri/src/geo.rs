//! 地名搜索。用来把「浙江省杭州市西湖区」这种中文地名换成经纬度。
//!
//! 为什么不用 Open-Meteo 自带的 geocoding：它按 GeoNames 的主名字匹配，
//! 中文「西湖区」「阳新县」都返回空，只有拼音/英文能命中，做不到区县级。
//! 实测 photon（OSM 数据）能直接吃中文，并且返回 state / city / name 三段，
//! 正好拼成「浙江省 · 杭州市 · 西湖区」。

use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
pub struct Place {
    /// 完整展示名，如「浙江省 · 杭州市 · 西湖区」
    pub label: String,
    /// 最末级名字，如「西湖区」，卡片标题用它
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    /// city / county / district / state …
    pub kind: String,
}

#[derive(Deserialize)]
struct Resp {
    #[serde(default)]
    features: Vec<Feature>,
}

#[derive(Deserialize)]
struct Feature {
    properties: Props,
    geometry: Geom,
}

#[derive(Deserialize, Default)]
struct Props {
    #[serde(default)]
    name: String,
    #[serde(default)]
    city: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    county: String,
    #[serde(default)]
    countrycode: String,
    #[serde(default, rename = "osm_value")]
    osm_value: String,
    #[serde(default, rename = "type")]
    kind: String,
}

#[derive(Deserialize)]
struct Geom {
    #[serde(default)]
    coordinates: Vec<f64>,
}

fn push_unique(out: &mut Vec<Place>, label: String, name: String, lat: f64, lon: f64, kind: String) {
    if out.iter().any(|p| (p.lat - lat).abs() < 0.02 && (p.lon - lon).abs() < 0.02) {
        return;
    }
    out.push(Place { label, name, lat, lon, kind });
}

pub async fn search(q: &str) -> Result<Vec<Place>, String> {
    let q = q.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let url = format!(
        "https://photon.komoot.io/api/?q={}&limit=10",
        urlencode(q)
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent("fy-desktop/0.4 (desktop widget)")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(url).send().await.map_err(|e| format!("搜索失败: {e}"))?;
    let v: Resp = resp.json().await.map_err(|e| format!("解析失败: {e}"))?;

    let mut out = Vec::new();
    for f in v.features {
        let p = f.properties;
        // 只保留中国的行政地名，医院/餐馆之类的 POI 不要
        if !p.countrycode.is_empty() && p.countrycode != "CN" {
            continue;
        }
        let is_admin = matches!(
            p.osm_value.as_str(),
            "city" | "town" | "village" | "county" | "state" | "district" | "region"
        ) || matches!(p.kind.as_str(), "district" | "city" | "county" | "state");
        if !is_admin || p.name.is_empty() {
            continue;
        }
        let Some(lat) = f.geometry.coordinates.get(1).copied() else {
            continue;
        };
        let Some(lon) = f.geometry.coordinates.first().copied() else {
            continue;
        };

        let mut parts: Vec<&str> = Vec::new();
        if !p.state.is_empty() {
            parts.push(&p.state);
        }
        let mid = if !p.city.is_empty() { &p.city } else { &p.county };
        if !mid.is_empty() && mid != &p.state && mid != &p.name {
            parts.push(mid);
        }
        if *parts.last().unwrap_or(&"") != p.name.as_str() {
            parts.push(&p.name);
        }
        let label = parts.join(" · ");
        let kind = if p.osm_value.is_empty() { p.kind.clone() } else { p.osm_value.clone() };
        push_unique(&mut out, label, p.name.clone(), lat, lon, kind);
        if out.len() >= 8 {
            break;
        }
    }
    Ok(out)
}

/// 只处理查询词：中文按 UTF-8 百分号编码，空格转 %20
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
