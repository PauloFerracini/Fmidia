const { openDb } = require('./db');
const { createApp } = require('./app');
const { startScheduler } = require('./scheduler');
const { seed } = require('./seed');

const db = openDb();
if (process.env.FMIDIA_NO_DEMO !== '1' && seed(db)) console.log('Conta demo criada: demo@fmidia.com / demo123');
const port = Number(process.env.PORT) || 3000;
createApp(db).listen(port, () => console.log(`Fmidia rodando em http://localhost:${port}`));
startScheduler(db);
