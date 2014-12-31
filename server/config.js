exports.PORT = process.env.PORT || 3000;
// Format: postgres://<user>:<pass>@<host>:<port>/<dbname>
exports.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/guild';
// 'development' | 'production'
exports.NODE_ENV = process.env.NODE_ENV || 'development';

if (exports.NODE_ENV === 'development') {
  console.log('Config vars:');
  console.log(JSON.stringify(exports, null, '  '));
}
