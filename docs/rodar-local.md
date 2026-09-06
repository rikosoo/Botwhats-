# Rodar no seu computador

Antes de colocar num servidor, vale rodar tudo na sua máquina: o modo demonstração usa um canal
simulado, então **nada é enviado no WhatsApp** e nenhum paciente real é tocado.

## Começar do zero (recomendado se algo estiver estranho)

Apaga a pasta antiga e baixa tudo de novo — resolve versão desatualizada, dependência quebrada e
arquivo em cache de uma vez.

**Windows (PowerShell):**

```powershell
cd $HOME\Desktop
Remove-Item -Recurse -Force Botwhats- -ErrorAction SilentlyContinue
git clone https://github.com/rikosoo/Botwhats-.git
cd Botwhats-
git checkout claude/whatsapp-bot-reminders-calendar-vsf20z
npm install --omit=optional
npm run demo
```

**Mac ou Linux:**

```bash
cd ~/Desktop
rm -rf Botwhats-
git clone https://github.com/rikosoo/Botwhats-.git
cd Botwhats-
git checkout claude/whatsapp-bot-reminders-calendar-vsf20z
npm install --omit=optional
npm run demo
```

Depois abra <http://localhost:3000> — de preferência numa **janela anônima**, que ignora o que o
navegador guardou de versões anteriores. Entre com `Henrique` / `Henrique123`.

Para parar: `Ctrl + C` no terminal.

## 1. Instalar o Node

Precisa do **Node 20 ou mais novo**. Baixe em <https://nodejs.org> (versão LTS) e confira:

```bash
node -v
```

## 2. Baixar e instalar

```bash
git clone https://github.com/rikosoo/Botwhats-.git
cd Botwhats-
git checkout claude/whatsapp-bot-reminders-calendar-vsf20z
npm install --omit=optional
cp .env.example .env
```

O `--omit=optional` pula o `whatsapp-web.js`, que só é necessário para conectar no WhatsApp de
verdade. Para o modo demonstração ele não faz falta.

## 3. Rodar a demonstração

```bash
npm run demo
```

Isso apaga o banco de teste, cria um consultório de exemplo (pacientes, consultas, faltas
registradas, lista de espera, urgência) e sobe o painel em <http://localhost:3000>.

Entre com **Henrique / Henrique123** — a senha padrão.

> Se já existir um `data/db.json`, ele é guardado como `data/db.json.antes-do-demo` antes de ser
> substituído. Nada é perdido sem aviso.

## 4. O que testar

No painel, o campo de mensagem embaixo do chat **é o simulador**: você escreve como se fosse o
paciente e vê a resposta do bot na hora. Vale experimentar:

| Escreva | O que deve acontecer |
| --- | --- |
| `oi` | Saudação conforme a hora do dia + aviso de privacidade |
| `quanto custa a consulta?` | Valor, o que está incluso, pagamento e **dois horários concretos** |
| `quero marcar uma consulta` | Fluxo completo: tipo, convênio, profissional, dia, horário, cadastro |
| `tanto faz` | No passo do profissional, escolhe quem tem a agenda mais próxima |
| `8h` (com 08:00 e 08:20 livres) | O bot pergunta qual, em vez de chutar |
| `estou com dor no peito` | **Interrompe tudo**, orienta 192 e joga para a fila da recepção |
| `posso tomar dipirona?` | Recusa opinar e encaminha |
| `vocês atendem unimed?` | Lista os convênios ativos |
| `preciso remarcar` | Libera o horário e recomeça a escolha |
| `não` (com consulta marcada) | Marca como *não vem* e avisa a recepção |
| 🎤 **Áudio** / 📷 **Foto** | Simula mídia: o bot responde e chama a recepção |
| `não quero mais receber mensagens` | Opt-out, cancela todos os lembretes |

No alto da coluna da direita há uma **caixa de seleção** com as nove seções do painel:

| Seção | O que tem lá |
| --- | --- |
| 📅 Hoje | Agenda do dia; marcar *compareceu* / *faltou* / *confirmar* |
| 🗓️ Agenda | **Semana inteira**, próximas consultas, lista de espera e horários livres para encaixe |
| 🔔 Lembretes | Fila do que vai sair, com *enviar agora* e *cancelar* |
| 📣 Disparo | Mensagem para um grupo de pacientes |
| 📊 Números | Taxa de falta, confirmou × não confirmou, ocupação |
| 🕘 Atividade | Linha do tempo do que aconteceu |
| 👩‍⚕️ Equipe | Médicos, especialidades, horários e **bloqueios de agenda** (dia inteiro ou só uma faixa) |
| ✍️ Mensagens | **Editar os textos que o bot fala** |
| ⚙️ Ajustes | **Convênios**, dados do consultório, **Google Agenda**, agenda dos médicos e troca de senha |

Para ver a lista de espera funcionando: cancele uma consulta futura na aba Agenda e veja a vaga
sendo oferecida a quem está na fila.

No celular o painel mostra uma coluna de cada vez, escolhida na barra de baixo (👥 Pacientes, 💬
Conversa, 📋 Painel). No computador, o **⛶** ao lado do seletor faz a seção ocupar a tela toda —
útil para a visão de semana.

Mensagem que chega e ninguém abriu aparece com **contador verde** na lista de pacientes, no alto do
painel e no título da aba do navegador. O 🔔 ao lado liga o aviso sonoro.

## 5. Testar com o WhatsApp de verdade (ainda local)

Se quiser provar o caminho completo antes de subir para a AWS:

```bash
npm install whatsapp-web.js qrcode-terminal
```

No `.env`, troque para `CHANNEL=whatsapp` e rode `npm start`. Um QR Code aparece no terminal — leia
com **WhatsApp → Aparelhos conectados**. Use um número que não seja o do consultório enquanto
estiver testando; quem escrever para ele vai falar com o bot.

Para voltar ao simulador, é só devolver `CHANNEL=mock` no `.env`.

## 6. Rodar os testes

```bash
npm test
```

São 98 testes cobrindo triagem de urgência, agenda, lembretes, disparo, lista de espera, login e
privacidade. Se algum falhar na sua máquina, me mande a saída — é o jeito mais rápido de descobrir
diferença de ambiente.

## Limpar tudo

```bash
rm data/db.json      # apaga pacientes, consultas e usuários do painel
npm run demo         # começa de novo
```
