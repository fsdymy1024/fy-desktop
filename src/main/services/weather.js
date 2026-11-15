'use strict';

/**
 * 天气：双源回退
 * ------------------------------------------------------------------
 * Open-Meteo 数据结构好、免 Key，但在国内网络经常连不上；
 * wttr.in 在国内容易通，但只有 3 小时粒度的预报。
 * 所以按「Open-Meteo → wttr.in」顺序尝试，任一成功即返回，
 * 两个都失败时返回上一次缓存并标记 stale，UI 显示「天气不可用」而不是空白卡片。
 */

const { net } = require('electron');

const TTL = 15 * 60 * 1000;

/* ---------------- WMO（Open-Meteo）---------------- */
const WMO = {
  0: ['晴', 'sun'], 1: ['晴间多云', 'sun-cloud'], 2: ['多云', 'cloud'], 3: ['阴', 'cloud'],
  45: ['有雾', 'fog'], 48: ['雾凇', 'fog'],
  51: ['毛毛雨', 'drizzle'], 53: ['小雨', 'drizzle'], 55: ['细雨', 'drizzle'],
  56: ['冻雨', 'rain'], 57: ['冻雨', 'rain'],
  61: ['小雨', 'rain'], 63: ['中雨', 'rain'], 65: ['大雨', 'rain'],
  66: ['冻雨', 'rain'], 67: ['强冻雨', 'rain'],
  71: ['小雪', 'snow'], 73: ['中雪', 'snow'], 75: ['大雪', 'snow'], 77: ['米雪', 'snow'],
  80: ['阵雨', 'rain'], 81: ['强阵雨', 'rain'], 82: ['暴雨', 'rain'],
  85: ['阵雪', 'snow'], 86: ['强阵雪', 'snow'],
  95: ['雷阵雨', 'thunder'], 96: ['雷雨冰雹', 'thunder'], 99: ['强雷雨冰雹', 'thunder']
};

/* ---------------- WWO（wttr.in）---------------- */
const WWO = {
  113: ['晴', 'sun'], 116: ['晴间多云', 'sun-cloud'], 119: ['多云', 'cloud'], 122: ['阴', 'cloud'],
  143: ['薄雾', 'fog'], 248: ['有雾', 'fog'], 260: ['冻雾', 'fog'],
  176: ['零星小雨', 'drizzle'], 185: ['毛毛雨', 'drizzle'], 263: ['毛毛雨', 'drizzle'], 266: ['毛毛雨', 'drizzle'],
  281: ['冻毛毛雨', 'drizzle'], 284: ['冻毛毛雨', 'drizzle'],
  293: ['小雨', 'rain'], 296: ['小雨', 'rain'], 299: ['中雨', 'rain'], 302: ['中雨', 'rain'],
  305: ['大雨', 'rain'], 308: ['暴雨', 'rain'], 353: ['阵雨', 'rain'], 356: ['强阵雨', 'rain'], 359: ['暴雨', 'rain'],
  179: ['阵雪', 'snow'], 182: ['雨夹雪', 'snow'], 227: ['吹雪', 'snow'], 230: ['暴风雪', 'snow'],
  320: ['雨夹雪', 'snow'], 323: ['小雪', 'snow'], 326: ['小雪', 'snow'], 329: ['中雪', 'snow'],
  332: ['中雪', 'snow'], 335: ['大雪', 'snow'], 338: ['大雪', 'snow'],
  368: ['阵雪', 'snow'], 371: ['强阵雪', 'snow'], 374: ['冰粒', 'snow'], 377: ['冰粒', 'snow'],
  200: ['雷阵雨', 'thunder'], 386: ['雷阵雨', 'thunder'], 389: ['强雷雨', 'thunder'], 392: ['雷雪', 'thunder'], 395: ['强雷雪', 'thunder'],
  311: ['冻雨', 'rain'], 314: ['强冻雨', 'rain'], 317: ['雨夹雪', 'snow'], 350: ['冰粒', 'snow'],
  362: ['雨夹雪', 'snow'], 365: ['雨夹雪', 'snow']
};

const describe = (table, code, fallbackText = '未知') => {
  const hit = table[code];
  return hit ? { text: hit[0], icon: hit[1] } : { text: fallbackText, icon: 'cloud' };
};

let cache = { at: 0, data: null, key: '' };

async function getJSON(url, timeout = 5000) {
  const res = await net.fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ---------------- 数据源 1：Open-Meteo ---------------- */
async function fromOpenMeteo(lat, lon, city) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('current', 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m');
  url.searchParams.set('hourly', 'temperature_2m,weather_code');
  url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', '2');

  const json = await getJSON(url.toString(), 4500);
  const cur = json.current || {};
  const hourly = json.hourly || {};
  const daily = json.daily || {};
  const times = hourly.time || [];
  const temps = hourly.temperature_2m || [];
  const codes = hourly.weather_code || [];

  const nowStamp = new Date();
  const nowHour = new Date(nowStamp.getFullYear(), nowStamp.getMonth(), nowStamp.getDate(), nowStamp.getHours());
  let start = times.findIndex(t => new Date(t).getTime() >= nowHour.getTime());
  if (start < 0) start = 0;

  const hours = [];
  for (let i = 0; i < 6; i++) {
    const idx = start + i;
    if (idx >= times.length) break;
    const at = new Date(times[idx]);
    hours.push({
      label: i === 0 ? '现在' : `${at.getHours()}时`,
      temp: Math.round(temps[idx]),
      icon: describe(WMO, codes[idx]).icon
    });
  }

  const cond = describe(WMO, cur.weather_code);
  return {
    city: city || '当前位置',
    temp: Math.round(cur.temperature_2m),
    feels: Math.round(cur.apparent_temperature),
    humidity: Math.round(cur.relative_humidity_2m),
    wind: Math.round(cur.wind_speed_10m),
    cond: cond.text,
    icon: cond.icon,
    high: Math.round((daily.temperature_2m_max || [])[0] ?? cur.temperature_2m),
    low: Math.round((daily.temperature_2m_min || [])[0] ?? cur.temperature_2m),
    hours,
    source: 'open-meteo'
  };
}

/* ---------------- 数据源 2：wttr.in ---------------- */
async function fromWttr(cityName) {
  const q = encodeURIComponent(cityName || 'Shanghai');
  const json = await getJSON(`https://wttr.in/${q}?format=j1&lang=zh`, 6000);

  const cur = (json.current_condition || [])[0] || {};
  const day = (json.weather || [])[0] || {};
  const code = Number(cur.weatherCode);
  const cond = describe(WWO, code, (cur.weatherDesc || [{}])[0].value || '未知');

  const nowHour = new Date().getHours();
  const hourly = day.hourly || [];
  const hours = [];
  for (let i = 0; i < hourly.length; i++) {
    const h = hourly[i];
    const at = Math.round(Number(h.time) / 100);
    if (at < nowHour) continue;
    hours.push({
      label: hours.length === 0 ? '现在' : `${at}时`,
      temp: Math.round(Number(h.tempC)),
      icon: describe(WWO, Number(h.weatherCode)).icon
    });
    if (hours.length >= 6) break;
  }

  return {
    city: cityName || ((json.nearest_area || [{}])[0].areaName || [{}])[0].value || '当前位置',
    temp: Math.round(Number(cur.temp_C)),
    feels: Math.round(Number(cur.FeelsLikeC)),
    humidity: Math.round(Number(cur.humidity)),
    wind: Math.round(Number(cur.windspeedKmph)),
    cond: cond.text,
    icon: cond.icon,
    high: Math.round(Number(day.maxtempC)),
    low: Math.round(Number(day.mintempC)),
    hours,
    source: 'wttr.in'
  };
}

/* ---------------- 对外 ---------------- */
async function fetchWeather(lat, lon, city) {
  const key = `${lat},${lon},${city}`;
  if (cache.data && cache.key === key && Date.now() - cache.at < TTL) {
    return { ...cache.data, stale: false, cached: true };
  }

  const errors = [];

  try {
    const data = await fromOpenMeteo(lat, lon, city);
    cache = { at: Date.now(), data, key };
    return { ...data, stale: false };
  } catch (err) {
    errors.push(`open-meteo: ${err.message}`);
  }

  try {
    const data = await fromWttr(city);
    cache = { at: Date.now(), data, key };
    return { ...data, stale: false };
  } catch (err) {
    errors.push(`wttr: ${err.message}`);
  }

  if (cache.data && cache.key === key) {
    return { ...cache.data, stale: true, error: errors.join(' / ') };
  }
  return { error: errors.join(' / '), stale: true };
}

module.exports = { fetchWeather };
