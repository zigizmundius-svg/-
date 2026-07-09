/**
 * price-scraper.js
 * Мини-сервис на Express, который умеет доставать цену товара с четырёх
 * площадок: DNS, М.Видео, Wildberries, Ozon.
 *
 * ДВА РАЗНЫХ ПУТИ, в зависимости от площадки:
 *
 *   A) DNS, М.Видео, Ozon — рендерим страницу настоящим браузером (Playwright)
 *      и достаём цену из structured data (schema.org JSON-LD), которую сайты
 *      обязаны публиковать для Google Покупок — это НАМНОГО стабильнее, чем
 *      CSS-классы, которые меняются при каждом редизайне. Если JSON-LD не
 *      нашёлся — fallback на CSS-селекторы (их придётся актуализировать
 *      самостоятельно, раз в несколько месяцев сайты меняют вёрстку).
 *
 *   B) Wildberries — браузер не нужен вообще. У WB есть простой публичный
 *      JSON-эндпоинт card.wb.ru/cards/detail, который отдаёт цену по
 *      артикулу напрямую, без рендеринга и без антибота. Обычный HTTP-запрос.
 *
 * Запуск:
 *   npm init -y
 *   npm install express playwright node-fetch
 *   npx playwright install chromium
 *   node price-scraper.js
 *
 * Использование (из n8n через HTTP Request node):
 *   POST http://localhost:3000/scrape
 *   body: { "url": "https://www.dns-shop.ru/product/..." }
 *   ответ: { "url", "name", "price", "currency", "source" }
 *
 *   Работает одинаково для ссылок dns-shop.ru, mvideo.ru, wildberries.ru, ozon.ru —
 *   сервис сам определяет площадку по домену и выбирает нужный метод.
 */

const express = require('express');
const { chromium } = require('playwright');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  return browserPromise;
}

// Достаём JSON-LD блоки типа Product/Offer со страницы
function extractJsonLdPrice(jsonLdBlocks) {
  for (const raw of jsonLdBlocks) {
    try {
      const data = JSON.parse(raw);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const node = item['@graph'] ? item['@graph'].find(n => n['@type'] === 'Product') : item;
        if (node && (node['@type'] === 'Product' || node.offers)) {
          const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
          if (offer && offer.price) {
            return {
              name: node.name || null,
              price: parseFloat(String(offer.price).replace(/[^\d.]/g, '')),
              currency: offer.priceCurrency || 'RUB',
            };
          }
        }
      }
    } catch (e) {
      // не JSON-LD или битый — пропускаем
    }
  }
  return null;
}

// Fallback-селекторы под конкретные площадки (используются в браузерном пути).
// ВАЖНО: сайты периодически меняют вёрстку — если парсер вдруг начал
// возвращать null, в первую очередь проверяйте актуальность этих селекторов.
const SITE_FALLBACKS = {
  'dns-shop.ru': {
    priceSelector: '[data-role="product-buy"] .product-buy__price, .product-buy__price',
    nameSelector: 'h1',
  },
  'mvideo.ru': {
    priceSelector: '[data-test-id="price-current"], .price-block__final-price',
    nameSelector: 'h1',
  },
  'ozon.ru': {
    priceSelector: '[data-widget="webPrice"] span, [data-widget="webOfferGrid"] span',
    nameSelector: 'h1',
  },
};

// --- Wildberries: отдельный путь, без браузера ---
// Извлекаем числовой артикул (nm) из любой ссылки вида
// https://www.wildberries.ru/catalog/123456789/detail.aspx
function extractWbArticle(url) {
  const match = url.match(/catalog\/(\d+)/);
  return match ? match[1] : null;
}

async function scrapeWildberries(url) {
  const nm = extractWbArticle(url);
  if (!nm) {
    return { error: 'не удалось извлечь артикул из ссылки Wildberries' };
  }

  const apiUrl = `https://card.wb.ru/cards/detail?appType=0&curr=rub&dest=-1257786&spp=30&nm=${nm}`;
  const resp = await fetch(apiUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    },
  });

  if (!resp.ok) {
    return { error: `WB API вернул статус ${resp.status}` };
  }

  const data = await resp.json();
  const product = data?.data?.products?.[0];
  if (!product) {
    return { error: 'товар не найден в ответе WB API — возможно, сменился формат ответа' };
  }

  // Цены в API приходят в копейках (priceU — без скидки, salePriceU — с учётом скидки продавца)
  return {
    name: product.name,
    price: product.salePriceU / 100,
    currency: 'RUB',
    source: 'wb-public-api',
  };
}

function getSiteConfig(url) {
  const hostname = new URL(url).hostname;
  for (const key of Object.keys(SITE_FALLBACKS)) {
    if (hostname.includes(key)) return SITE_FALLBACKS[key];
  }
  return null;
}

app.post('/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const hostname = new URL(url).hostname;

  // Wildberries — отдельная, более простая и быстрая ветка (без браузера)
  if (hostname.includes('wildberries.ru')) {
    const result = await scrapeWildberries(url);
    if (result.error) return res.status(422).json({ url, ...result });
    return res.json({ url, ...result });
  }

  // DNS, М.Видео, Ozon — общий браузерный путь ниже
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    locale: 'ru-RU',
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    // 1. Пробуем structured data (самый надёжный способ)
    const jsonLdBlocks = await page.$$eval('script[type="application/ld+json"]', nodes =>
      nodes.map(n => n.textContent)
    );
    const fromJsonLd = extractJsonLdPrice(jsonLdBlocks);
    if (fromJsonLd && fromJsonLd.price) {
      await context.close();
      return res.json({ url, source: 'json-ld', ...fromJsonLd });
    }

    // 2. Fallback на CSS-селекторы под конкретный сайт
    const config = getSiteConfig(url);
    if (config) {
      const priceText = await page.locator(config.priceSelector).first().textContent().catch(() => null);
      const name = await page.locator(config.nameSelector).first().textContent().catch(() => null);
      if (priceText) {
        const price = parseFloat(priceText.replace(/[^\d]/g, ''));
        await context.close();
        return res.json({ url, source: 'css-fallback', name: name?.trim(), price, currency: 'RUB' });
      }
    }

    await context.close();
    return res.status(422).json({ url, error: 'price not found — проверьте селекторы или капчу' });
  } catch (err) {
    await context.close();
    return res.status(500).json({ url, error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`price-scraper listening on :${PORT}`));
