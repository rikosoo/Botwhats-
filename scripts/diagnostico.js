'use strict';

/**
 * Confere o essencial e diz o que fazer quando algo não está no lugar.
 *
 *   npm run diagnostico
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const raiz = path.join(__dirname, '..');
const linhas = [];
const problemas = [];

const ok = (texto) => linhas.push(`  ✅ ${texto}`);
const aviso = (texto, comoResolver) => {
  linhas.push(`  ⚠️  ${texto}`);
  problemas.push(comoResolver);
};

// ---------- ambiente ----------

const nodeMaior = Number(process.versions.node.split('.')[0]);
if (nodeMaior >= 20) ok(`Node ${process.versions.node}`);
else aviso(`Node ${process.versions.node} é antigo`, 'Instale o Node 20 ou mais novo.');

// ---------- configuração ----------

const config = require('../src/config');
const envPath = path.join(raiz, '.env');
if (fs.existsSync(envPath)) ok('Arquivo .env encontrado');
else aviso('Não há .env', 'Rode: cp .env.example .env — e edite os valores.');

const temCertificado = fs.existsSync(config.sslCert) && fs.existsSync(config.sslKey);
if (temCertificado) ok('Certificado encontrado — o painel sobe em HTTPS');
else linhas.push('  ℹ️  Sem certificado: o painel sobe em HTTP (rode "npm run certificado SEU_IP")');

linhas.push(`  ℹ️  Canal: ${config.channel} · escutando em ${config.host}:${config.port} · fuso ${config.timezone}`);

if (config.channel === 'whatsapp') {
  const chrome = config.chromiumPath || '/usr/bin/google-chrome-stable';
  if (fs.existsSync(chrome)) ok(`Chrome encontrado em ${chrome}`);
  else {
    aviso(`Chrome não encontrado em ${chrome}`,
      'Instale: wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb '
      + '&& sudo apt install -y ./google-chrome-stable_current_amd64.deb');
  }

  for (const pacote of ['whatsapp-web.js', 'qrcode']) {
    try {
      require.resolve(pacote);
      ok(`Pacote ${pacote} instalado`);
    } catch {
      aviso(`Pacote ${pacote} não instalado`, `Rode: npm install ${pacote}`);
    }
  }

  const sessao = path.join(raiz, '.wwebjs_auth');
  if (fs.existsSync(sessao)) ok('Sessão do WhatsApp já existe (não deve pedir QR de novo)');
  else linhas.push('  ℹ️  Ainda sem sessão do WhatsApp: o QR Code vai aparecer no painel');
} else {
  linhas.push('  ℹ️  Modo simulador: nada é enviado no WhatsApp. Para conectar, use CHANNEL=whatsapp no .env');
}

// ---------- dados ----------

if (fs.existsSync(config.dataFile)) {
  const banco = JSON.parse(fs.readFileSync(config.dataFile, 'utf8'));
  ok(`Banco com ${(banco.contacts || []).length} paciente(s) e ${(banco.bookings || []).length} consulta(s)`);
  if (!(banco.users || []).length) linhas.push('  ℹ️  Nenhum usuário criado ainda; o padrão nasce ao iniciar');
} else {
  linhas.push('  ℹ️  Banco ainda não criado — ele nasce na primeira execução');
}

// ---------- memória ----------

try {
  const livre = execSync('free -m 2>/dev/null || true').toString();
  const swap = /Swap:\s+(\d+)/.exec(livre);
  if (swap && Number(swap[1]) > 0) ok(`Swap de ${swap[1]} MB configurado`);
  else if (swap) {
    aviso('Sem swap', 'O Chrome derruba máquina pequena sem swap. Veja o passo 3 de docs/deploy-aws.md.');
  }
} catch { /* fora do Linux, tudo bem */ }

// ---------- como acessar ----------

console.log('\n  Diagnóstico do Botwhats\n');
console.log(linhas.join('\n'));

console.log('\n  Como abrir o painel:');
if (config.host === '127.0.0.1') {
  console.log('    O painel só responde dentro desta máquina — de propósito.');
  console.log('    No SEU computador, abra um túnel e acesse http://localhost:3000 :');
  console.log('      ssh -i chave.pem -L 3000:127.0.0.1:3000 ubuntu@SEU_IP');
  console.log('    Abrir o IP do servidor direto no navegador nunca vai funcionar assim.');
} else {
  const esquema = temCertificado ? 'https' : 'http';
  console.log(`    ${esquema}://SEU_IP:${config.port} — com a porta liberada no grupo de segurança.`);
  if (temCertificado) {
    console.log('    Digitar http:// também funciona: o servidor redireciona para https.');
    console.log('    O navegador avisa que o certificado é do próprio servidor: Avançado → Prosseguir.');
  }
}

if (problemas.length) {
  console.log('\n  Pendências:');
  problemas.forEach((p, i) => console.log(`    ${i + 1}. ${p}`));
  process.exitCode = 1;
} else {
  console.log('\n  Nada pendente. 🎉\n');
}
