const { MongoClient } = require('mongodb');

let client;
let connectionPromise;
let database;

async function connectToDatabase() {
  if (database) {
    return database;
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not configured');
  }

  if (!client) {
    client = new MongoClient(uri);
    connectionPromise = client.connect();
  }

  try {
    await connectionPromise;
    database = client.db();
    return database;
  } catch (error) {
    client = undefined;
    connectionPromise = undefined;
    throw error;
  }
}

async function getNovelsCollection() {
  const db = await connectToDatabase();
  return db.collection('novels');
}

async function getChaptersCollection() {
  const db = await connectToDatabase();
  return db.collection('chapters');
}

module.exports = {
  connectToDatabase,
  getNovelsCollection,
  getChaptersCollection,
};
