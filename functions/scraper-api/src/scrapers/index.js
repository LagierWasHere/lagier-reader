const cheerio = require('cheerio');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DOMAIN_SELECTORS = {
  royalroad: {
    title: ['.fic-title h1', '.fiction-header h1', 'h1'],
    author: ['.fic-title h2 a', '.fiction-header a[href*="/profile/"]', '[rel="author"]'],
    cover: ['.fiction-cover img', '.fiction-header img', 'meta[property="og:image"]'],
    synopsis: ['.description', '.fiction-description', 'meta[name="description"]'],
    tags: ['.tags a', '.fiction-tags a', '[rel="tag"]'],
    chapters: [
      '.chapter-row a[href]',
      '#chapters a[href*="/chapter/"]',
      'a[href*="/chapter/"]',
    ],
    content: ['.chapter-inner', '.chapter-content-inner', '.chapter-content', 'article'],
  },
  novelphoenix: {
    title: ['.novel-title', '.book-title', '.entry-title', 'h1'],
    author: [
      '.novel-author',
      '.book-author',
      '.author',
      '[rel="author"]',
      'meta[name="author"]',
    ],
    cover: [
      '.novel-cover img',
      '.book-cover img',
      '.novel-thumbnail img',
      'meta[property="og:image"]',
      'meta[name="twitter:image"]',
    ],
    synopsis: [
      '.synopsis',
      '.summary',
      '.description',
      '.book-description',
      'meta[name="description"]',
    ],
    tags: ['.tags a', '.genres a', '.genre a', '[rel="tag"]'],
    chapters: [
      '.chapter-list a[href]',
      '.chapters a[href]',
      '#chapter-list a[href]',
      '#list a[href]',
      '.entry-content a[href]',
      'a[href*="/chapter/"]',
      'a[href*="/read/"]',
    ],
    content: [
      '.chapter-content',
      '#chapter-content',
      '.reading-content',
      '.entry-content',
      '.post-content',
      'article',
      'main',
    ],
  },
  chikari: {
    title: ['.novel-title', '.book-title', 'h1'],
    author: ['.novel-author', '.book-author', '[rel="author"]', '[class*="author"]'],
    cover: ['.novel-cover img', '.book-cover img', 'meta[property="og:image"]'],
    synopsis: ['.synopsis', '.summary', '.description', 'meta[name="description"]'],
    tags: ['.tags a', '.genres a', '.genre a', '[rel="tag"]'],
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
    synopsis: [
      '.synopsis',
      '.summary',
      '.description',
      '.book-description',
      'meta[name="description"]',
    ],
    tags: ['.tags a', '.genres a', '.genre a', '[rel="tag"]'],
    chapters: [
      '.chapter-list a[href]',
      '.chapters a[href]',
      '#chapter-list a[href]',
      '#list a[href]',
      '[class*="chapter"] a[href]',
      '[class*="episode"] a[href]',
    ],
    content: [
      'article',
      '[class*="chapter-content"]',
      '[class*="chapter-body"]',
      '.entry-content',
      '.post-content',
      '#content',
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

function canonicalizeUrl(url) {
  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname.toLowerCase().replace(/^www\./, '');
  const legacyMatch = parsedUrl.pathname.match(/^\/novel\/([^/]+)\/?$/i);

  if (hostname === 'novelphoenix.com' && legacyMatch) {
    return `https://novelphoenix.net/${legacyMatch[1]}.html`;
  }

  return parsedUrl.href;
}

function toAbsoluteUrl(value, baseUrl) {
  if (!value) {
    return null;
  }

  try {
    const rawValue = value.trim();
    if (!rawValue || rawValue.startsWith('#') || rawValue.toLowerCase().startsWith('javascript:')) {
      return null;
    }

    const absoluteUrl = new URL(rawValue, baseUrl);
    if (!['http:', 'https:'].includes(absoluteUrl.protocol)) {
      return null;
    }
    return absoluteUrl.toString();
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

function getStructuredData($) {
  const values = [];

  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const parsed = JSON.parse($(element).contents().text());
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item && typeof item === 'object' && Array.isArray(item['@graph'])) {
          values.push(...item['@graph']);
        } else if (item && typeof item === 'object') {
          values.push(item);
        }
      }
    } catch {
      // Ignore malformed JSON-LD and continue with the page markup.
    }
  });

  return values.find((item) => {
    const type = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
    return type.some((value) => ['Book', 'Article', 'CreativeWork'].includes(value));
  }) || values[0] || {};
}

function getStructuredAuthor(data) {
  if (typeof data.author === 'string') {
    return data.author.trim();
  }

  if (Array.isArray(data.author)) {
    const author = data.author.find((item) => item && typeof item.name === 'string');
    return author ? author.name.trim() : '';
  }

  if (data.author && typeof data.author.name === 'string') {
    return data.author.name.trim();
  }

  return '';
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

function getTags($, selectors = []) {
  const tags = [];
  const seen = new Set();

  for (const selector of selectors) {
    $(selector).each((_, element) => {
      const tag = $(element).text().replace(/\s+/g, ' ').trim();
      const key = tag.toLowerCase();
      if (tag && !seen.has(key)) {
        seen.add(key);
        tags.push(tag);
      }
    });
  }

  return tags;
}

function parseChapterNumber(title, url, fallback) {
  const match = `${title} ${url}`.match(
    /(?:chapter|chap|ch\.?|episode|ep\.?|volume|vol\.?|#)[^\d]*(\d+(?:\.\d+)?)/i,
  );
  const number = match ? Number(match[1]) : fallback;
  return Number.isFinite(number) ? number : fallback;
}

function isChapterLink(title, href, baseUrl) {
  const normalizedTitle = title.toLowerCase();
  const normalizedHref = href.toLowerCase();
  const basePath = new URL(baseUrl).pathname.replace(/\/+$/, '').toLowerCase();

  if (normalizedHref === baseUrl.toLowerCase() || new URL(href).pathname === basePath) {
    return false;
  }

  return (
    /\b(chapter|chap|ch\.?|episode|ep\.?|part|volume|vol\.?)\b/i.test(title) ||
    /(?:chapter|chap|episode|ep|volume|vol)[-_/.]?\d/i.test(normalizedHref) ||
    /\b\d+(?:\.\d+)?\b/.test(normalizedTitle)
  );
}

function parseChapters($, selectors, baseUrl) {
  const chapters = [];
  const seenUrls = new Set();

  const addChapter = (element) => {
    const link = $(element);
    const href = toAbsoluteUrl(link.attr('href'), baseUrl);
    const title =
      link.text().replace(/\s+/g, ' ').trim() ||
      link.attr('title') ||
      link.attr('data-title') ||
      link.attr('aria-label') ||
      '';

    if (!href || !title || seenUrls.has(href) || !isChapterLink(title, href, baseUrl)) {
      return;
    }

    seenUrls.add(href);
    chapters.push({
      title,
      url: href,
      number: parseChapterNumber(title, href, chapters.length + 1),
    });
  };

  for (const selector of selectors) {
    $(selector).each((_, element) => addChapter(element));
  }

  if (!chapters.length) {
    $('a[href]').each((_, element) => addChapter(element));
  }

  if (chapters.length > 1 && chapters.every((chapter) => Number.isFinite(chapter.number))) {
    chapters.sort((left, right) => left.number - right.number);
  }

  return chapters;
}

function getPaginationLinks($, baseUrl) {
  const links = [];
  const seenUrls = new Set();

  $('a[href]').each((_, element) => {
    const link = $(element);
    const url = toAbsoluteUrl(link.attr('href'), baseUrl);
    if (!url || seenUrls.has(url)) {
      return;
    }

    const text = link.text().replace(/\s+/g, ' ').trim().toLowerCase();
    const rel = (link.attr('rel') || '').toLowerCase().split(/\s+/);
    const className = (link.attr('class') || '').toLowerCase();
    const paginationContainer = link.closest(
      '.pagination, .pager, .page-numbers, .nav-links, [class*="pagination"], [class*="pager"]',
    );
    const pageNumber = getPageNumber(url);
    const isPaginationLink =
      rel.includes('next') ||
      rel.includes('prev') ||
      paginationContainer.length > 0 ||
      Boolean(pageNumber) ||
      /\b(first|last|next|prev|previous|older|newer)\b/.test(text) ||
      /\b(next|prev|previous|older|newer)\b/.test(className);

    if (isPaginationLink) {
      seenUrls.add(url);
      links.push({
        url,
        text,
        rel,
        pageNumber,
        isLast: /\blast\b/.test(text) || /\blast\b/.test(className),
        isNext: rel.includes('next') || /\bnext\b/.test(text) || /\bnext\b/.test(className),
      });
    }
  });

  return links;
}

function getPageNumber(url) {
  const parsedUrl = new URL(url);
  for (const key of ['page', 'paged', 'p']) {
    const value = Number(parsedUrl.searchParams.get(key));
    if (Number.isInteger(value) && value > 0) {
      return { type: 'query', key, value };
    }
  }

  const match = parsedUrl.pathname.match(/\/(?:page|paged)\/(\d+)(?:\/|$)/i);
  if (match) {
    return { type: 'path', value: Number(match[1]) };
  }

  return null;
}

function replacePageNumber(url, pageNumber, pagePattern) {
  const parsedUrl = new URL(url);
  if (pagePattern.type === 'query') {
    parsedUrl.searchParams.set(pagePattern.key, String(pageNumber));
  } else {
    parsedUrl.pathname = parsedUrl.pathname.replace(
      /\/(?:page|paged)\/\d+(?=\/|$)/i,
      (match) => match.replace(/\d+/, String(pageNumber)),
    );
  }
  return parsedUrl.href;
}

function getPaginatedPageUrls($, baseUrl) {
  const links = getPaginationLinks($, baseUrl);
  const nextLink = links.find((link) => link.isNext);
  const lastLink = links.find((link) => link.isLast);
  const nextPage = nextLink && getPageNumber(nextLink.url);
  const lastPage = lastLink && getPageNumber(lastLink.url);

  if (nextPage && lastPage && nextPage.type === lastPage.type) {
    const pageUrls = [];
    for (let page = nextPage.value; page <= lastPage.value; page += 1) {
      pageUrls.push(replacePageNumber(nextLink.url, page, nextPage));
    }
    return pageUrls;
  }

  const numberedPages = links
    .filter((link) => link.pageNumber)
    .map((link) => link.url);
  if (numberedPages.length) {
    return numberedPages;
  }

  return nextLink ? [nextLink.url] : [];
}

async function fetchPaginatedPages(firstPage) {
  const pages = [firstPage];
  const visitedUrls = new Set([firstPage.url]);
  let currentPage = firstPage;

  for (let pageNumber = 0; pageNumber < 1000; pageNumber += 1) {
    const pageUrls = getPaginatedPageUrls(
      cheerio.load(currentPage.html),
      currentPage.url,
    );
    if (!pageUrls.length) {
      break;
    }

    const newPageUrls = pageUrls.filter((url) => !visitedUrls.has(url));
    if (!newPageUrls.length) {
      break;
    }

    const additionalPages = await Promise.all(
      newPageUrls.map(async (url) => {
        try {
          return await fetchPage(url);
        } catch {
          return null;
        }
      }),
    );
    const fetchedPages = additionalPages.filter(Boolean);
    pages.push(...fetchedPages);
    fetchedPages.forEach((page) => visitedUrls.add(page.url));
    if (fetchedPages.length !== newPageUrls.length || fetchedPages.length > 1) {
      break;
    }
    currentPage = fetchedPages[0];
  }

  return pages;
}

async function fetchPage(url) {
  let parsedUrl;
  try {
    parsedUrl = new URL(canonicalizeUrl(url));
  } catch {
    throw new TypeError(`Invalid URL: ${url}`);
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new TypeError(`Unsupported URL protocol: ${parsedUrl.protocol}`);
  }

  const response = await fetch(parsedUrl, {
    signal: AbortSignal.timeout(15000),
    redirect: 'follow',
    headers: {
      Accept: 'text/html,application/xhtml+xml,text/html;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
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
  const firstPage = await fetchPage(url);
  const pages = await fetchPaginatedPages(firstPage);
  const $ = cheerio.load(firstPage.html);
  const structuredData = getStructuredData($);
  const selectors = DOMAIN_SELECTORS[getSiteKey(firstPage.url)];

  const title =
    getFirstValue($, selectors.title, 'content') ||
    structuredData.name ||
    structuredData.headline ||
    getFirstValue($, ['title']) ||
    '';
  const author =
    getFirstValue($, selectors.author, 'content') || getStructuredAuthor(structuredData);
  const synopsis =
    getFirstValue($, selectors.synopsis || [], 'content') ||
    structuredData.description ||
    getFirstValue($, ['meta[name="description"]'], 'content') ||
    '';
  const structuredTags = [
    ...(Array.isArray(structuredData.genre)
      ? structuredData.genre
      : typeof structuredData.genre === 'string'
        ? structuredData.genre.split(',')
        : []),
    ...(typeof structuredData.keywords === 'string'
      ? structuredData.keywords.split(',')
      : []),
  ];
  const tags = [...getTags($, selectors.tags), ...structuredTags]
    .filter((tag) => typeof tag === 'string')
    .map((tag) => tag.trim())
    .filter((tag, index, values) => tag && values.indexOf(tag) === index);
  const chapters = pages.flatMap((page) => {
    const page$ = cheerio.load(page.html);
    return parseChapters(page$, selectors.chapters, page.url);
  });
  const uniqueChapters = [];
  const seenChapterUrls = new Set();
  for (const chapter of chapters) {
    if (!seenChapterUrls.has(chapter.url)) {
      seenChapterUrls.add(chapter.url);
      uniqueChapters.push(chapter);
    }
  }
  if (uniqueChapters.every((chapter) => Number.isFinite(chapter.number))) {
    uniqueChapters.sort((left, right) => left.number - right.number);
  }

  return {
    title,
    author,
    coverImageUrl:
      getCoverUrl($, selectors.cover, firstPage.url) ||
      toAbsoluteUrl(
        typeof structuredData.image === 'string'
          ? structuredData.image
          : Array.isArray(structuredData.image)
            ? structuredData.image[0]
            : structuredData.image?.url,
        firstPage.url,
      ),
    synopsis,
    tags,
    chapters: uniqueChapters,
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
