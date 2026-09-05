# Botwhats — bot de WhatsApp com lembretes e agenda

Bot de atendimento para WhatsApp que **responde a saudação**, envia **lembretes de 1, 7 e 15 dias**,
tem uma **agenda própria de horários disponíveis** e um **painel web** onde dá para acompanhar todas
as interações em tempo real.

![painel](docs/painel.png)

## O que ele faz

| Recurso | Detalhe |
| --- | --- |
| Saudação automática | "Bom dia / Boa tarde / Boa noite" conforme o horário, com o nome do contato e o menu de opções |
| Menu guiado | 1 Agendar · 2 Meus agendamentos · 3 Horários disponíveis · 4 Falar com atendente · 0 Encerrar |
| Lembretes 1/7/15 | **Follow-up:** 1, 7 e 15 dias *depois* do contato, para quem ainda não agendou (o relógio reinicia a cada nova mensagem). **Agendamento:** 15, 7 e 1 dia *antes* do horário marcado |
| Agenda | Horários de atendimento por dia da semana, duração configurável do slot, exceções por data, reserva e cancelamento |
| Painel web | Conversas, bolhas de mensagem estilo WhatsApp, simulador, agenda clicável, fila de lembretes, linha do tempo de atividade e editor de horários |
| Opt-out | Responder `SAIR` cancela todos os lembretes e marca o contato |

## Como rodar

```bash
npm install
cp .env.example .env
npm run seed     # opcional: cria conversas de exemplo
npm start        # painel em http://localhost:3000
```

Por padrão o `CHANNEL=mock`: nada é enviado para o WhatsApp de verdade e você testa o fluxo
inteiro pelo simulador do painel (campo de mensagem + botões de atalho `Oi`, `1`, `AGENDAR`, `SIM`…).

### Conectando no WhatsApp de verdade

```bash
npm install whatsapp-web.js qrcode-terminal   # dependências opcionais
# no .env:  CHANNEL=whatsapp
npm start
```

Um QR Code aparece no terminal — leia com **WhatsApp › Aparelhos conectados**. A sessão fica salva
em `.wwebjs_auth/`, então não é preciso ler o QR toda vez.

> `whatsapp-web.js` automatiza o WhatsApp Web e **não é uma API oficial**. Para uso comercial em
> escala, o caminho suportado é a **WhatsApp Cloud API** da Meta. Trocar de canal é simples: basta
> criar um adaptador em `src/channels/` com os métodos `start()`, `sendText(phone, texto)` e o
> callback `onMessage({ phone, name, body })` — o resto do bot não muda.

## Configuração (`.env`)

| Variável | Padrão | Para que serve |
| --- | --- | --- |
| `CHANNEL` | `mock` | `mock` (simulador) ou `whatsapp` (QR Code) |
| `PORT` | `3000` | Porta do painel |
| `TZ` | `America/Sao_Paulo` | Fuso usado na agenda e nos lembretes |
| `BUSINESS_NAME` | `Minha Empresa` | Nome exibido nas mensagens |
| `SCHEDULER_INTERVAL_MS` | `30000` | De quanto em quanto tempo os lembretes vencidos são enviados |
| `CHROMIUM_PATH` | — | Caminho do Chromium, se o Puppeteer não achar sozinho |

Os intervalos dos lembretes ficam em `src/config.js` (`followUpOffsets` e `bookingOffsets`) — mude
para `[3, 10, 30]`, por exemplo, se precisar de outra cadência.

## Horários disponíveis

Configure na aba **Horários** do painel (faixas por dia da semana, ex.: `09:00-12:00, 14:00-18:00`,
e a duração de cada atendimento). Deixe o campo vazio para fechar o dia.

Para fechar ou abrir uma data específica (feriado, plantão), use as *exceções*:

```bash
curl -X PUT localhost:3000/api/availability -H 'content-type: application/json' \
  -d '{"exceptions": {"2026-12-25": [], "2026-12-26": [{"start":"09:00","end":"12:00"}]}}'
```

## API

| Método | Rota | Descrição |
| --- | --- | --- |
| `GET` | `/api/state` | Snapshot completo usado pelo painel |
| `GET` | `/api/stream` | Server-Sent Events: atualiza o painel em tempo real |
| `POST` | `/api/simulate` | Injeta uma mensagem do cliente (`{phone, name, body}`) |
| `POST` | `/api/messages` | Envia mensagem manual do atendente (`{contactId, body}`) |
| `GET` | `/api/slots?date=YYYY-MM-DD` | Horários livres da data |
| `GET`/`PUT` | `/api/availability` | Lê/atualiza os horários de atendimento |
| `POST` | `/api/bookings` | Cria agendamento (`{contactId, date, start}`) |
| `DELETE` | `/api/bookings/:id` | Cancela agendamento e seus lembretes |
| `POST` | `/api/reminders/:id/send` | Antecipa o envio de um lembrete |
| `DELETE` | `/api/reminders/:id` | Cancela um lembrete |
| `POST` | `/api/contacts/:id/followups` | Reagenda os lembretes de 1/7/15 dias |
| `GET` | `/api/health` | Status do canal e contadores |

## Estrutura

```
src/
  index.js            entrada: sobe painel, canal e agendador
  app.js              liga armazenamento, agenda, lembretes, bot e canal
  config.js           .env + parâmetros dos lembretes
  server.js           API REST + SSE + arquivos do painel
  core/bot.js         conversa: saudação, menu, agendamento, cancelamento
  core/agenda.js      fuso horário, geração de horários, reservas
  core/reminders.js   agendador dos lembretes de 1/7/15 dias
  channels/mock.js    canal de simulação
  channels/whatsappWeb.js  canal real (QR Code)
  db/store.js         persistência em JSON (data/db.json)
public/               painel web (HTML + CSS + JS puros)
test/                 testes com node:test
```

Os dados ficam em `data/db.json` — arquivo único, sem banco para instalar. Para produção com
volume maior, `src/db/store.js` é o único arquivo a trocar por Postgres/SQLite.

## Testes

```bash
npm test
```

Cobrem a conversão de fuso horário, a geração e reserva de horários, as três janelas de lembrete
(incluindo opt-out e agendamento cancelado) e o fluxo completo de agendamento pelo menu.
