const { MongoClient } = require('mongodb');

const JSON_FIELDS = new Set(['chapters', 'tags']);

let client;
let connectionPromise;
let storage;

function getAppwriteConfig() {
  const databaseId =
    process.env.APPWRITE_DATABASE_ID || process.env.APPWRITE_DATABASE;
  const apiKey =
    process.env.APPWRITE_API_KEY || process.env.APPWRITE_FUNCTION_API_KEY;
  const projectId =
    process.env.APPWRITE_PROJECT_ID || process.env.APPWRITE_FUNCTION_PROJECT_ID;
  const endpoint =
    process.env.APPWRITE_ENDPOINT ||
    process.env.APPWRITE_FUNCTION_API_ENDPOINT ||
    'https://cloud.appwrite.io/v1';

  if (!databaseId || !apiKey || !projectId) {
    return null;
  }

  return {
    endpoint: endpoint.replace(/\/+$/, ''),
    projectId,
    apiKey,
    databaseId,
    novelsTableId: process.env.APPWRITE_NOVELS_TABLE_ID || 'novels',
    chaptersTableId: process.env.APPWRITE_CHAPTERS_TABLE_ID || 'chapters',
  };
}

function serializeData(data) {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([key, value]) => key !== '_id' && value !== undefined)
      .map(([key, value]) => [
        key,
        JSON_FIELDS.has(key) ? JSON.stringify(value) : value,
      ])
  );
}

function deserializeData(data, rowId) {
  const result = { ...data, _id: rowId };
  for (const field of JSON_FIELDS) {
    if (typeof result[field] !== 'string') {
      continue;
    }

    try {
      result[field] = JSON.parse(result[field]);
    } catch {
      // Preserve malformed legacy values instead of dropping the row.
    }
  }
  return result;
}

function getNestedValue(document, path) {
  return path.split('.').reduce((value, part) => value?.[part], document);
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function matchesFilter(document, filter = {}) {
  if (filter.$or) {
    return filter.$or.some((candidate) => matchesFilter(document, candidate));
  }

  return Object.entries(filter).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && '$exists' in expected) {
      return (getNestedValue(document, key) !== undefined) === expected.$exists;
    }
    return valuesEqual(getNestedValue(document, key), expected);
  });
}

class TablesCollection {
  constructor(config, tableId) {
    this.config = config;
    this.tableId = tableId;
  }

  async request(method, path, body) {
    const response = await fetch(
      `${this.config.endpoint}/databases/${encodeURIComponent(
        this.config.databaseId
      )}/tables/${encodeURIComponent(this.tableId)}/rows${path}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Appwrite-Project': this.config.projectId,
          'X-Appwrite-Key': this.config.apiKey,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }
    );

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        payload.message ||
          `Appwrite TablesDB request failed (${response.status})`
      );
    }
    return payload;
  }

  async listRows() {
    const rows = [];
    let offset = 0;

    while (true) {
      const payload = await this.request('GET', `?limit=100&offset=${offset}`);
      const page = Array.isArray(payload.rows) ? payload.rows : [];
      rows.push(...page.map((row) => deserializeData(row.data || {}, row.$id)));
      if (page.length < 100) {
        return rows;
      }
      offset += page.length;
    }
  }

  find(filter = {}) {
    const query = {
      sort: null,
      toArray: async () => {
        let rows = (await this.listRows()).filter((row) =>
          matchesFilter(row, filter)
        );
        if (query.sort) {
          const [[field, direction]] = Object.entries(query.sort);
          rows = rows.sort((left, right) => {
            const leftValue = getNestedValue(left, field);
            const rightValue = getNestedValue(right, field);
            if (leftValue === rightValue) {
              return 0;
            }
            return (leftValue > rightValue ? 1 : -1) * direction;
          });
        }
        return rows;
      },
      sort: (sort) => {
        query.sort = sort;
        return query;
      },
    };
    return query;
  }

  async findOne(filter = {}) {
    return (
      (await this.listRows()).find((row) => matchesFilter(row, filter)) || null
    );
  }

  async updateOne(filter, update) {
    const existing = await this.findOne(filter);
    if (!existing) {
      return { matchedCount: 0, modifiedCount: 0 };
    }

    const data = applyUpdate(existing, update, false);
    await this.request('PATCH', `/${encodeURIComponent(existing._id)}`, {
      data: serializeData(data),
    });
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async findOneAndUpdate(filter, update, options = {}) {
    const existing = await this.findOne(filter);
    if (!existing && !options.upsert) {
      return null;
    }

    const data = applyUpdate(existing || {}, update, !existing);
    const rowId =
      existing?._id ||
      `row-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const payload = existing
      ? await this.request('PATCH', `/${encodeURIComponent(rowId)}`, {
          data: serializeData(data),
        })
      : await this.request('POST', '', {
          rowId,
          data: serializeData(data),
        });
    return deserializeData(payload.data || data, payload.$id || rowId);
  }

  async deleteOne(filter) {
    const existing = await this.findOne(filter);
    if (!existing) {
      return { deletedCount: 0 };
    }

    await this.request('DELETE', `/${encodeURIComponent(existing._id)}`);
    return { deletedCount: 1 };
  }
}

function applyUpdate(existing, update, isInsert) {
  return {
    ...existing,
    ...(isInsert ? update.$setOnInsert || {} : {}),
    ...(update.$set || {}),
  };
}

async function connectToDatabase() {
  if (storage) {
    return storage;
  }

  const appwriteConfig = getAppwriteConfig();
  if (appwriteConfig) {
    storage = {
      type: 'appwrite',
      novels: new TablesCollection(
        appwriteConfig,
        appwriteConfig.novelsTableId
      ),
      chapters: new TablesCollection(
        appwriteConfig,
        appwriteConfig.chaptersTableId
      ),
    };
    return storage;
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      'Database is not configured. Set Appwrite TablesDB variables or MONGODB_URI.'
    );
  }

  if (!client) {
    client = new MongoClient(uri);
    connectionPromise = client.connect();
  }

  try {
    await connectionPromise;
    storage = {
      type: 'mongodb',
      database: client.db(),
    };
    return storage;
  } catch (error) {
    client = undefined;
    connectionPromise = undefined;
    throw error;
  }
}

async function getNovelsCollection() {
  const database = await connectToDatabase();
  return database.type === 'appwrite'
    ? database.novels
    : database.database.collection('novels');
}

async function getChaptersCollection() {
  const database = await connectToDatabase();
  return database.type === 'appwrite'
    ? database.chapters
    : database.database.collection('chapters');
}

module.exports = {
  connectToDatabase,
  getChaptersCollection,
  getNovelsCollection,
};
