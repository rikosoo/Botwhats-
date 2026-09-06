'use strict';

/**
 * Cria um certificado próprio para o painel, para a conexão deixar de ser texto puro.
 *
 *   npm run certificado              → usa o IP detectado da máquina
 *   npm run certificado 18.219.126.21
 *
 * O navegador vai avisar que o certificado não é de uma autoridade conhecida —
 * é esperado, porque quem assina é o próprio servidor. Em "Avançado → Prosseguir"
 * a conexão passa a ser criptografada do mesmo jeito, o que já resolve o problema
 * de senha e dados de paciente trafegando abertos.
 *
 * Para um certificado sem aviso, use o Tailscale ou um domínio — veja
 * docs/deploy-aws.md.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const raiz = path.join(__dirname, '..');
const destino = path.join(raiz, 'certs');
const crt = path.join(destino, 'painel.crt');
const key = path.join(destino, 'painel.key');

/** IPs próprios da máquina, para o certificado valer no endereço usado. */
function enderecos() {
  const lista = new Set(['127.0.0.1']);
  for (const grupo of Object.values(os.networkInterfaces())) {
    for (const item of grupo || []) {
      if (item.family === 'IPv4' && !item.internal) lista.add(item.address);
    }
  }
  return [...lista];
}

const informado = process.argv.slice(2).filter(Boolean);
const ips = [...new Set([...informado, ...enderecos()])];

fs.mkdirSync(destino, { recursive: true });

const san = ips.map((ip, i) => `IP.${i + 1} = ${ip}`).join('\n');
const conf = `
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no

[dn]
CN = ${ips[0]}
O = Botwhats

[v3]
subjectAltName = @alt
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt]
DNS.1 = localhost
${san}
`;

const confPath = path.join(destino, 'openssl.cnf');
fs.writeFileSync(confPath, conf);

try {
  execFileSync('openssl', [
    'req', '-x509', '-nodes', '-newkey', 'rsa:2048',
    '-days', '825',
    '-keyout', key, '-out', crt,
    '-config', confPath,
  ], { stdio: 'pipe' });
} catch (err) {
  console.error('\n  Não consegui gerar o certificado.');
  console.error('  Confira se o openssl está instalado: sudo apt install -y openssl\n');
  console.error(String(err.stderr || err.message).trim());
  process.exit(1);
}

fs.chmodSync(key, 0o600);
fs.unlinkSync(confPath);

console.log('\n  Certificado criado:');
console.log(`    ${path.relative(raiz, crt)}`);
console.log(`    ${path.relative(raiz, key)} (só o dono lê)`);
console.log(`\n  Vale para: ${['localhost', ...ips].join(', ')}`);
console.log('\n  Agora reinicie o serviço e acesse com https:// em vez de http://');
console.log('    sudo systemctl restart botwhats');
console.log('\n  O navegador vai avisar que o certificado é próprio. Em "Avançado → Prosseguir",');
console.log('  a conexão fica criptografada. Para um certificado sem aviso, veja docs/deploy-aws.md.\n');
