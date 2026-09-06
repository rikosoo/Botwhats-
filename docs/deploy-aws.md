# Subir na AWS com acesso só para você

Este guia coloca o bot numa EC2 e deixa o painel **sem nenhuma porta aberta para a internet**:
o acesso é por túnel SSH, e o único endereço exposto é o SSH, liberado apenas para o seu IP.

Por que assim, e não com domínio e HTTPS: o painel mostra nome, telefone, nascimento e conversa de
pacientes. Enquanto for só você usando, o caminho mais seguro é não publicar nada — sem porta
aberta não há tela de login para alguém tentar, nem certificado para configurar.

> **Antes de começar.** O `whatsapp-web.js` roda um Chrome de verdade no servidor. Isso pesa: conte
> com ~1,5 GB de RAM para ele. E é automação do WhatsApp Web, não API oficial — a sessão pode cair
> e exigir novo QR Code.

---

## 1. Criar a instância

No console da AWS, região **São Paulo (sa-east-1)** — menor latência para o Brasil.

**EC2 → Executar instância:**

| Campo | Valor |
| --- | --- |
| Nome | `botwhats` |
| Imagem | **Ubuntu Server 24.04 LTS** (x86_64) |
| Tipo | **t3.small** (2 vCPU, 2 GB) |
| Par de chaves | Criar novo, tipo RSA, formato `.pem` — **guarde o arquivo, não dá para baixar de novo** |
| Armazenamento | 20 GB gp3, com **Criptografia ativada** |

Sobre o tipo: `t3.micro` (1 GB) está no nível gratuito, mas com o Chrome aberto ele vive no limite e
o serviço reinicia sozinho. Se for testar no `t3.micro`, o swap do passo 3 deixa de ser opcional.

**Configurações de rede → Editar → Regras do grupo de segurança.** Deixe **uma única regra**:

| Tipo | Porta | Origem |
| --- | --- | --- |
| SSH | 22 | **Meu IP** |

Não abra a porta 3000. Ela não vai ficar acessível de fora — é esse o desenho.

> Se sua internet tem IP dinâmico (a maioria das residenciais tem), o acesso vai parar de funcionar
> quando o IP mudar. Quando isso acontecer: EC2 → Grupos de segurança → editar a regra → **Meu IP**
> de novo. É um clique.

## 2. IP fixo (Elastic IP)

Sem isso, parar e ligar a instância troca o endereço.

**EC2 → IPs elásticos → Alocar** → selecione o novo IP → **Ações → Associar** → escolha a instância.

Anote o IP. Ele aparece como `SEU_IP` daqui para a frente.

## 3. Primeiro acesso e preparo do sistema

No seu computador:

```bash
chmod 400 ~/Downloads/botwhats.pem          # a AWS recusa a chave se estiver aberta demais
ssh -i ~/Downloads/botwhats.pem ubuntu@SEU_IP
```

Já dentro do servidor:

```bash
sudo apt update && sudo apt upgrade -y
sudo timedatectl set-timezone America/Sao_Paulo

# Swap de 2 GB — o Chrome estoura a memória sem aviso em máquina pequena.
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git

# Chrome (traz junto todas as bibliotecas que o Puppeteer precisa)
wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt install -y ./google-chrome-stable_current_amd64.deb
rm google-chrome-stable_current_amd64.deb

node -v && google-chrome-stable --version
```

## 4. Trazer o código

Se o repositório for privado, crie uma chave de deploy:

```bash
ssh-keygen -t ed25519 -C "botwhats-ec2" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

Copie a saída e cole em **GitHub → repositório → Settings → Deploy keys → Add deploy key**
(pode deixar sem permissão de escrita). Depois:

```bash
cd ~
git clone git@github.com:rikosoo/Botwhats-.git
cd Botwhats-
git checkout claude/whatsapp-bot-reminders-calendar-vsf20z

# Instala as dependências sem baixar um segundo Chrome
PUPPETEER_SKIP_DOWNLOAD=true npm ci
```

O `npm ci` já instala o `whatsapp-web.js` e o `qrcode` (que desenha o QR no painel), porque estão
como dependências opcionais do projeto.

## 5. Configurar

```bash
cp .env.example .env
nano .env
```

Deixe assim (troque a senha por uma sua, longa):

```ini
CHANNEL=whatsapp
PORT=3000
HOST=127.0.0.1
TZ=America/Sao_Paulo
CHROMIUM_PATH=/usr/bin/google-chrome-stable

ADMIN_USER=Henrique
ADMIN_PASSWORD=uma-senha-longa-e-sua-2026
```

`HOST=127.0.0.1` é o ponto central: o painel passa a escutar só dentro da máquina. Mesmo que alguém
abra a porta 3000 no grupo de segurança por engano, não há nada ouvindo do lado de fora.

Depois de entrar pela primeira vez, troque a senha em **Ajustes → Acesso** — aí ela deixa de ficar
escrita no `.env`.

## 6. Ligar como serviço

```bash
sudo cp deploy/botwhats.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now botwhats
```

Acompanhe a subida com `journalctl -u botwhats -f` (saia com `Ctrl+C`; o serviço continua rodando).

## 7. Ligar o seu WhatsApp

O QR Code aparece **no próprio painel** — não precisa caçar no log. Abra o túnel (passo 8), entre no
painel e vá em **Ajustes → Conexão do WhatsApp**:

![QR Code no painel](qrcode.png)

No celular: **WhatsApp → Aparelhos conectados → Conectar um aparelho**, e aponte a câmera para o
código. O bloco muda para *"✅ WhatsApp conectado"* sozinho.

O código se renova a cada poucos segundos, e o painel acompanha — leia sempre o que estiver na tela.
A sessão fica salva em `.wwebjs_auth/`, então reiniciar o servidor não pede QR de novo. Se o
aparelho for desconectado algum dia, o QR reaparece nesse mesmo lugar.

> **Use um número dedicado ao consultório.** O aparelho que já usa o número continua funcionando
> normalmente, mas toda mensagem que chegar passa a ser respondida pelo bot.

## 8. Acessar o painel

No **seu computador** (não no servidor):

```bash
ssh -i ~/Downloads/botwhats.pem -L 3000:127.0.0.1:3000 ubuntu@SEU_IP
```

Com esse terminal aberto, abra <http://localhost:3000>. O tráfego vai criptografado dentro do SSH.
Fechou o terminal, o painel some. Entre com `Henrique` e a senha do `.env`, e troque a senha.

Para não digitar o comando toda vez, no seu `~/.ssh/config`:

```
Host botwhats
  HostName SEU_IP
  User ubuntu
  IdentityFile ~/Downloads/botwhats.pem
  LocalForward 3000 127.0.0.1:3000
```

Aí basta `ssh botwhats` e abrir <http://localhost:3000>.

## 9. Backup

O `data/db.json` guarda os pacientes e o `.wwebjs_auth/` guarda a sessão do WhatsApp. Perder o
primeiro é perder a agenda.

```bash
sudo cp deploy/backup.sh /usr/local/bin/botwhats-backup
sudo chmod +x /usr/local/bin/botwhats-backup
( crontab -l 2>/dev/null; echo "15 3 * * * /usr/local/bin/botwhats-backup" ) | crontab -
```

Isso guarda 14 dias de cópias em `~/backups`. Para mandar também para um bucket S3, crie o bucket
(com **bloqueio de acesso público** e versionamento), anexe à instância uma IAM role com permissão
de `s3:PutObject` só nesse bucket, e defina `BACKUP_S3=s3://seu-bucket/botwhats` no crontab.

Vale também ligar snapshots automáticos do disco: **EC2 → Ciclo de vida de dados → Criar política**,
diária, retendo 7 cópias.

## 10. Manutenção

```bash
# atualizar o código
cd ~/Botwhats- && git pull && PUPPETEER_SKIP_DOWNLOAD=true npm ci && sudo systemctl restart botwhats

# ver o que está acontecendo
systemctl status botwhats
journalctl -u botwhats -n 100 --no-pager

# a sessão do WhatsApp caiu? o QR volta a aparecer no log
journalctl -u botwhats -f
```

Segurança do sistema operacional, de tempos em tempos:

```bash
sudo apt update && sudo apt upgrade -y && sudo systemctl restart botwhats
```

## Custo

Ordem de grandeza em sa-east-1: a `t3.small` ligada 24h é o grosso da conta, mais uns poucos dólares
de disco (20 GB gp3) e centavos de tráfego. O Elastic IP é cobrado quando fica **sem** instância
associada — associado, não pesa. Confira os valores atuais na
[calculadora da AWS](https://calculator.aws/), porque preço muda e região sa-east-1 costuma ser mais
cara que us-east-1.

Para cortar custo, `sudo shutdown -h now` fora do horário do consultório funciona — mas o bot para
de responder e de enviar lembretes enquanto estiver desligado.

---

## Se depois você quiser acessar do celular

O túnel SSH resolve bem no computador, mas é ruim no celular. Duas saídas, em ordem de preferência:

**Tailscale (recomendado).** Uma VPN pessoal: você instala no servidor e no celular, os dois entram
na mesma rede privada, e o painel fica acessível pelo IP do tailnet — **continua sem porta aberta
para a internet**.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Depois troque `HOST=127.0.0.1` por `HOST=0.0.0.0` no `.env` e mantenha a porta 3000 fechada no grupo
de segurança — quem chega pelo Tailscale não passa por ele. Instale o app no celular e acesse
`http://100.x.y.z:3000`.

**Domínio com HTTPS.** Aí sim vale um proxy (Caddy resolve certificado sozinho), a porta 443 aberta
e `COOKIE_SECURE=true` no `.env`. É mais trabalho e passa a existir uma tela de login exposta ao
mundo — só faz sentido quando mais gente da equipe precisar entrar.

## Abrir o painel sem túnel (quando o SSH complica)

O túnel é o mais seguro, mas depende de rodar `ssh` no seu computador. Se estiver difícil —
por exemplo, você está entrando pelo **EC2 Instance Connect**, aquele terminal dentro do navegador —
dá para liberar a porta do painel **só para o seu IP**:

1. No `.env` do servidor, troque `HOST=127.0.0.1` por `HOST=0.0.0.0` e reinicie:
   `sudo systemctl restart botwhats`
2. **EC2 → Grupos de segurança → Editar regras de entrada → Adicionar regra**:
   TCP personalizado · porta **3000** · origem **Meu IP**
3. Abra `http://SEU_IP:3000` — **http, não https**, e com os pontos do IP.

O preço disso: a conexão é HTTP puro, sem criptografia. Sua senha do painel trafega em texto entre o
seu computador e a AWS. Serve para configurar e testar; para o uso diário, volte ao túnel ou coloque
o Tailscale (mais abaixo). E feche a porta 3000 quando terminar.

## Deixar a conexão criptografada (certificado)

Enquanto o painel roda em `http://`, senha e dados de paciente trafegam abertos. Três caminhos, do
mais rápido ao mais bonito:

### 1. Certificado próprio (2 minutos, funciona com IP)

```bash
cd ~/Botwhats-
npm run certificado 18.219.126.21     # troque pelo IP da sua instância
sudo systemctl restart botwhats
```

Agora acesse **`https://SEU_IP:3000`**. O navegador vai avisar que o certificado não é de uma
autoridade conhecida — é esperado, porque quem assinou foi o próprio servidor. Em
**Avançado → Prosseguir**, a conexão passa a ser criptografada do mesmo jeito. O aviso incomoda, mas
o problema real (dados em texto puro na rede) fica resolvido.

O certificado vale por 825 dias e fica em `certs/`, fora do git.

### 2. Tailscale (5 minutos, sem aviso e sem porta aberta) — recomendado

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale cert "$(tailscale status --json | grep -o '"DNSName":"[^"]*' | head -1 | cut -d'"' -f4 | sed 's/\.$//')"
```

Aponte `SSL_CERT` e `SSL_KEY` no `.env` para os arquivos gerados, reinicie, e acesse pelo nome
`.ts.net` da máquina. Certificado de verdade, sem aviso, sem nada exposto na internet — e funciona
do celular com o app do Tailscale.

### 3. Domínio próprio com Caddy

Se você tiver um domínio, o Caddy resolve o certificado sozinho. Vale quando mais gente da equipe
precisar entrar; aí a porta 443 fica aberta e existe uma tela de login exposta ao mundo.

Com HTTPS ligado, o cookie de sessão passa a exigir conexão segura automaticamente.

## Atualizar sem perder nada

```bash
cd ~/Botwhats-
npm run atualizar
```

O comando guarda uma cópia dos dados em `~/backups`, baixa a versão nova, instala dependências,
reinstala o serviço e roda o diagnóstico no fim.

**Os dados nunca são tocados pela atualização**: `data/db.json` (pacientes, consultas, usuários) e
`.wwebjs_auth/` (a sessão do WhatsApp) estão fora do git — o `git pull` não encosta neles, e a
sessão do WhatsApp continua conectada depois de atualizar.

## Ligar e desligar o atendimento automático

Em **Ajustes → Conexão do WhatsApp** há o interruptor **"Atendimento automático"**:

- **Ligado**: o bot responde sozinho.
- **Desligado**: as mensagens continuam chegando e aparecem no painel, mas ninguém responde
  automaticamente — os pacientes vão para a fila da recepção. Uma faixa fica fixa no topo do painel
  enquanto estiver assim, para ninguém esquecer que está desligado.

Os lembretes já programados continuam saindo nos dois casos. Para parar também os lembretes, pare o
serviço: `sudo systemctl stop botwhats`.

No mesmo bloco fica **Desconectar este número**, para vincular outro aparelho — depois de
desconectar, um QR novo aparece ali mesmo.

## Se algo der errado

Antes de tudo, rode no servidor: `cd ~/Botwhats- && npm run diagnostico`. Ele confere Node, `.env`,
Chrome, pacotes, swap e sessão do WhatsApp, e diz o comando de cada pendência.

| Sintoma | Provável causa |
| --- | --- |
| Abri `SEU_IP` no navegador e não carrega (`ERR_TIMED_OUT`) | **É o esperado.** Com `HOST=127.0.0.1` e a porta fechada, o painel não responde pela internet. Use o túnel e abra `http://localhost:3000`, ou siga "Abrir o painel sem túnel" acima |
| `https://SEU_IP` não abre | Não existe HTTPS aqui. É `http://`, e pelo túnel é `localhost` |
| `Could not resolve hostname 18-219-126-21` | O IP foi digitado com **hífens**. É com pontos: `18.219.126.21` |
| QR Code dá "inválido" no celular | O código expira em segundos. Leia o que está **no painel naquele instante** (ele se renova sozinho), nunca de um print ou de um log antigo |
| QR sempre inválido, mesmo lendo na hora | O serviço pode estar reiniciando por memória. Veja `journalctl -u botwhats -n 50` e confirme o swap com `free -h` |
| `https://` dá erro de certificado | Se você gerou o certificado próprio, é o aviso esperado: Avançado → Prosseguir |
| Atualizei e sumiram os pacientes | Não é a atualização: `data/` fica fora do git. Confira `ls -la data/` e as cópias em `~/backups` |
| `ssh` não conecta | Seu IP mudou. Atualize a regra do grupo de segurança para **Meu IP** |
| O painel não abre no `localhost:3000` | O túnel caiu junto com o terminal do `ssh -L`. Reabra |
| Serviço reiniciando sozinho | Memória. Confirme o swap (`free -h`) ou suba para `t3.small`/`t3.medium` |
| QR Code não aparece no painel | Confirme `CHANNEL=whatsapp` no `.env` e veja `journalctl -u botwhats -n 200`: falta de biblioteca do Chrome aparece aí |
| WhatsApp desconectou | Normal de tempos em tempos: leia o novo QR pelo log |
