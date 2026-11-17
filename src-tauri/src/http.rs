//! 共用的 HTTP 客户端。
//!
//! 以前天气、地名、更新检查、下载各自 `Client::builder().build()`，一个客户端一个
//! 连接池，请求之间不复用连接，DNS 也要重解析。这里全局一个带超时和 UA 的客户端，
//! 单次请求要更长的超时就自己 `.timeout(...)` 覆盖。

use std::sync::OnceLock;
use std::time::Duration;

pub fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(crate::consts::HTTP_TIMEOUT)
            .user_agent(crate::consts::UA)
            .build()
            .unwrap_or_default()
    })
}

/// 带自定义超时的一次 GET（返回值仍是 RequestBuilder，方便继续加 header）
pub fn get(url: &str, timeout: Duration) -> reqwest::RequestBuilder {
    client().get(url).timeout(timeout)
}
