require('dotenv').config(); 

const isProduction = process.env.NODE_ENV === 'production';

const dbConfig = {
  uri: process.env.MONGODB_URI || '', 
  options: {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    // Fail with a clear error if the initial connection cannot be established
    serverSelectionTimeoutMS: 30000,
  },
  isProduction,
  memoryServerOptions: {
    instance: { dbName: 'caddyManagerDevDB' },
    binary: {
      // 6.0.4 has no Debian 12 build; 7.0.x is supported by mongoose 7 and MMS 10.
      version: process.env.MONGOMS_VERSION || '7.0.14',
    },
  },
};

module.exports = dbConfig;
