'use strict';

/**
 * Modo demonstração: apaga o banco, popula com um consultório de exemplo e
 * sobe o painel — tudo no simulador, sem WhatsApp e sem tocar em número real.
 *
 *   npm run demo
 */

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const raiz = path.join(__dirname, '..');
const banco = path.join(raiz, 'data', 'db.json');

if (fs.existsSync(banco)) {
  const backup = `${banco}.antes-do-demo`;
  fs.copyFileSync(banco, backup);
  console.log(`Banco anterior guardado em ${path.relative(raiz, backup)}`);
  fs.unlinkSync(banco);
}

const seed = spawnSync(process.execPath, [path.join(__dirname, 'seed.js')], {
  stdio: 'inherit',
  env: { ...process.env, CHANNEL: 'mock' },
});
if (seed.status !== 0) process.exit(seed.status || 1);

console.log('\n  Modo demonstração — canal simulado, nada é enviado no WhatsApp.');
console.log('  Entre com o usuário e a senha do .env (padrão: Henrique / Henrique123).\n');

const app = spawn(process.execPath, [path.join(raiz, 'src', 'index.js')], {
  stdio: 'inherit',
  env: { ...process.env, CHANNEL: 'mock', TYPING_DELAY_MS: '0' },
});
process.on('SIGINT', () => app.kill('SIGINT'));
app.on('exit', (code) => process.exit(code || 0));
