const cheerio = require('cheerio');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DOMAIN_SELECTORS = {
  royalroad: {
    title: ['.fic-title h1', '.fiction-header h1', 'h1'],
    author: ['.fic-title h2 a', '.fiction-header a[href*="/profile/"]', '[rel="author"]'],
    cover: ['.fiction-cover img', '.fiction-header img', 'meta[property="og:image"]'],
    chapters: [
      '.chapter-row a[href]',
      '#chapters a[href*="/chapter/"]',
      'a[href*="/chapter/"]',
    ],
    content: ['.chapter-inner', '.chapter-content-inner', '.chapter-content', 'article'],
  },
  novelphoenix: {
    title: ['.novel-title', '.book-title', 'h1'],
    author: ['.novel-author', '.book-author', '[rel="author"]', '[class*="author"]'],
    cover: ['.novel-cover img', '.book-cover img', 'meta[property="og:image"]'],
    chapters: [
      '.chapter-list a[href]',
      '.chapters a[href]',
      'a[href*="/chapter/"]',
      'a[href*="/read/"]',
    ],
    content: ['.chapter-content', '.entry-content', 'article', 'main'],
  },
  chikari: {
    title: ['.novel-title', '.book-title', 'h1'],
    author: ['.novel-author', '.book-author', '[rel="author"]', '[class*="author"]'],
    cover: ['.novel-cover img', '.book-cover img', 'meta[property="og:image"]'],
    chapters: [
      '.chapter-list a[href]',
      '.chapter-list-item a[href]',
      'a[href*="/chapter/"]',
    ],
    content: ['.chapter-content', '.chapter-body', 'article', 'main'],
  },
  generic: {
    title: ['h1', '[class*="title"] h1', 'meta[property="og:title"]'],
    author: ['[rel="author"]', '[class*="author"]', 'meta[name="author"]'],
    cover: [
      'meta[property="og:image"]',
      'meta[name="twitter:image"]',
      'img[class*="cover"]',
      '.cover img',
    ],
    chapters: [
      '.chapter-list a[href]',
      '.chapters a[href]',
      '[class*="chapter"] a[href]',
      '[class*="episode"] a[href]',
    ],
    content: [
      'article',
      '[class*="chapter-content"]',
      '[class*="chapter-body"]',
      '.entry-content',
      'main',
    ],
  },
};

function getSiteKey(url) {
  const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');

  if (hostname === 'royalroad.com' || hostname.endsWith('.royalroad.com')) {
    return 'royalroad';
  }
  if (hostname.includes('novelphoenix')) {
    return 'novelphoenix';
  }
  if (hostname.includes('chikari.moe')) {
    return 'chikari';
  }
  return 'generic';
}

function toAbsoluteUrl(value, baseUrl) {
  if (!value) {
    return null;
  }

  try {
    return new URL(value, baseUrl).href;
  } catch {
    return null;
  }
}

function getFirstValue($, selectors, attribute) {
  for (const selector of selectors) {
    const element = $(selector).first();
    if (!element.length) {
      continue;
    }

    const value = attribute ? element.attr(attribute) || element.text() : element.text();
    if (value && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function getCoverUrl($, selectors, baseUrl) {
  for (const selector of selectors) {
    const element = $(selector).first();
    if (!element.length) {
      continue;
    }

    const value = element.attr('content') || element.attr('src') || element.attr('data-src');
    const url = toAbsoluteUrl(value, baseUrl);
    if (url) {
      return url;
    }
  }
  return null;
}

function parseChapterNumber(title, url, fallback) {
  const match = `${title} ${url}`.match(
    /(?:chapter|chap|ch\.?|episode|ep\.?|volume|vol\.?|#)[^\d]*(\d+(?:\.\d+)?)/i,
  );
  const number = match ? Number(match[1]) : fallback;
  return Number.isFinite(number) ? number : fallback;
}

function parseChapters($, selectors, baseUrl) {
  const chapters = [];
  const seenUrls = new Set();

  for (const selector of selectors) {
    $(selector).each((index, element) => {
      const link = $(element);
      const href = toAbsoluteUrl(link.attr('href'), baseUrl);
      const title =
        link.text().replace(/\s+/g, ' ').trim() ||
        link.attr('title') ||
        link.attr('aria-label') ||
        '';

      if (!href || !title || seenUrls.has(href)) {
        return;
      }

      seenUrls.add(href);
      chapters.push({
        title,
        url: href,
        number: parseChapterNumber(title, href, chapters.length + 1),
      });
    });

    if (chapters.length) {
      break;
    }
  }

  return chapters;
}

async function fetchPage(url) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new TypeError(`Invalid URL: ${url}`);
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new TypeError(`Unsupported URL protocol: ${parsedUrl.protocol}`);
  }

  const response = await fetch(parsedUrl, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return {
    html: await response.text(),
    url: response.url || parsedUrl.href,
  };
}

async function scrapeNovel(url) {
  const page = await fetchPage(url);
  const $ = cheerio.load(page.html);
  const selectors = DOMAIN_SELECTORS[getSiteKey(page.url)];

  const title =
    getFirstValue($, selectors.title, 'content') ||
    getFirstValue($, ['title']) ||
    '';
  const author = getFirstValue($, selectors.author, 'content') || '';

  return {
    title,
    author,
    coverImageUrl: getCoverUrl($, selectors.cover, page.url),
    chapters: parseChapters($, selectors.chapters, page.url),
  };
}

function cleanChapterContent($, root) {
  root
    .find(
      [
        'script',
        'style',
        'noscript',
        'iframe',
        'nav',
        'header',
        'footer',
        'form',
        'button',
        '[role="navigation"]',
        '[class*="advert"]',
        '[class*="banner"]',
        '[class*="sidebar"]',
        '[class*="social"]',
        '.ad',
        '.ads',
      ].join(','),
    )
    .remove();

  root.find('a').each((_, element) => {
    const text = $(element).text().replace(/\s+/g, ' ').trim().toLowerCase();
    if (/^(next|previous|prev|back|table of contents|toc)$/.test(text)) {
      $(element).remove();
    }
  });

  root.find('p').each((_, element) => {
    if (!$(element).text().replace(/\s+/g, ' ').trim()) {
      $(element).remove();
    }
  });

  return {
    html: root.html()?.trim() || '',
    text: root.text().replace(/\s+/g, ' ').trim(),
  };
}

async function scrapeChapter(url) {
  const page = await fetchPage(url);
  const $ = cheerio.load(page.html);
  const selectors = DOMAIN_SELECTORS[getSiteKey(page.url)];
  let contentRoot;

  for (const selector of selectors.content) {
    const candidate = $(selector).first();
    if (candidate.length && candidate.text().trim()) {
      contentRoot = candidate;
      break;
    }
  }

  if (!contentRoot) {
    throw new Error(`Could not find chapter content at ${url}`);
  }

  const title =
    getFirstValue($, ['h1', 'h2', 'meta[property="og:title"]'], 'content') ||
    getFirstValue($, ['h1', 'h2', 'title']) ||
    '';
  const content = cleanChapterContent($, contentRoot);

  return {
    title,
    content: content.html,
    text: content.text,
  };
}

module.exports = {
  scrapeNovel,
  scrapeChapter,
};
