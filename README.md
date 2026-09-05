# Botwhats — autoatendimento humanizado de consultório no WhatsApp

Assistente de WhatsApp para consultório médico: recebe o paciente com uma **saudação natural**,
**agenda consultas** na agenda dos profissionais, envia **lembretes de 1, 7 e 15 dias**, pede
**confirmação de presença** e mantém um **painel para a recepção** acompanhar tudo em tempo real.

![painel da recepção](docs/painel.png)

## Por que "humanizado"

O bot conversa como a recepção conversaria — não como uma URA.

| Em vez de | O bot faz |
| --- | --- |
| "DIGITE 1 PARA AGENDAR" | Entende *"queria marcar uma consulta"*, *"preciso de um retorno"*, *"tanto faz"*, *"às 10h"*. Os números são atalho da lista, não obrigação |
| Repetir a mesma frase | Alterna variações de saudação e de resposta, e chama o paciente pelo primeiro nome |
| Ignorar o contexto | Se perguntam o endereço no meio do agendamento, ele responde **e retoma de onde parou** |
| Insistir quando não entende | Depois de três tentativas, passa para a secretária em vez de repetir o menu |
| Mandar tudo de uma vez | Pausa entre mensagens proporcional ao tamanho do texto, como alguém digitando |
| Chutar | *"8h"* com 08:00 e 08:20 livres vira *"tenho 08:00 e 08:20, qual delas?"* |

## Pergunta de preço

Responder só o número faz o paciente comparar com o consultório da esquina e decidir por preço.
A resposta sai completa e termina em **dois horários concretos**:

> *Primeira consulta* — R$ 400,00
> **O que está incluso:** 40 minutos com o Dr. …, avaliação completa, leitura dos seus exames,
> plano de tratamento por escrito, retorno em até 30 dias sem custo.
> Aceitamos Pix, dinheiro e cartão. Pelo convênio, atendemos Unimed, …
>
> Sobre a agenda, tenho estes dois horários:
> **1.** segunda-feira (07/09) às 09:20  **2.** terça-feira (08/09) às 08:00

Aceitar um deles leva direto ao cadastro; recusar volta para a escolha normal de dia. O que está
incluso em cada tipo de atendimento fica em `src/clinic.js` (`price`, `includes`).

![resposta de preço](docs/preco.png)

## Segurança clínica — o que o bot **não** faz

Isto é uma regra do código, não uma recomendação:

- **Não avalia sintomas, não dá conduta, não interpreta exames.** Perguntas do tipo *"posso tomar
  dipirona?"* recebem sempre a mesma resposta: isso é com o médico, na consulta.
- **Triagem de sinais de alarme** (`src/core/triage.js`): dor no peito, falta de ar, desmaio,
  sinais de AVC, sangramento intenso, ideação suicida e afins **interrompem qualquer fluxo**,
  orientam *192 / pronto-socorro / CVV 188*, marcam o paciente como urgente no painel e chamam a equipe.
- **Nada de dados de saúde por mensagem.** O aviso de privacidade (LGPD) vai uma vez, no primeiro
  contato, e o bot só coleta o mínimo para o cadastro: nome, nascimento e convênio.
- **Sem cobrança para quem está mal.** Paciente em urgência ou na fila da recepção não recebe
  follow-up automático.
- **`sair`** cancela todos os lembretes na hora.

## Lembretes 1 / 7 / 15

São duas frentes, configuráveis em `src/config.js`:

| Frente | Quando dispara | Conteúdo |
| --- | --- | --- |
| **Follow-up** | 1, 7 e 15 dias **depois** do contato de quem não marcou (o relógio reinicia a cada mensagem) | Convite para agendar; o de 15 dias é o último e oferece opt-out |
| **Antes da consulta** | **7 e 3 dias antes** | Utilidade, sem contagem regressiva: leve exames recentes, que o médico já adianta o plano. Nenhum lembrete diz "faltam X dias" |
| **Véspera** | 1 dia antes | **Mostra o tempo reservado** ("a Dra. reservou 40 minutos só para você"), manda endereço e preparo, abre a porta de saída e pede um **sim ou não** simples |
| **Meio da espera** | Só quando o silêncio entre marcar e o primeiro lembrete passa de 10 dias | Preenche o vazio de quem marcou com muita antecedência |
| **Check-in** | Um dia depois da consulta, quando a recepção marca *compareceu* | "Ficou alguma dúvida sobre as orientações?" — a resposta cai na fila da recepção |
| **Retorno** | Conforme `returnDays` do tipo de atendimento (padrão: 30 dias após a primeira consulta) | Convite para o retorno |
| **Falta** | Dia seguinte a uma falta marcada no painel | Mensagem de reaproximação, sem cobrança |

Por que a véspera mostra o que foi reservado antes de pedir o sim: perguntar "confirma?" de saída
faz o paciente responder no automático, sem abrir a agenda dele. Mostrando os minutos separados e
**dando permissão para desmarcar**, o "não" chega antes do dia — e o horário volta para a agenda a
tempo de encaixar outra pessoa. Quem responde **não** aparece no painel como *não vem*, com KPI
próprio, para a recepção agir na hora.

Nenhum lembrete faz contagem regressiva: "faltam 7 dias" cobra, "leve seus exames que a médica já
adianta o plano" ajuda — e ambos lembram da consulta.

Um lembrete só sai se ainda fizer sentido: quem marcou no meio do caminho não recebe follow-up,
e consulta cancelada não gera aviso.

## Agenda

- **Vários profissionais**, cada um com a própria grade semanal, duração de encaixe e exceções por data (férias, feriado).
- **Tipos de atendimento** com durações diferentes (primeira consulta 40 min, retorno 20 min, exame 30 min) — a duração define a cadência dos horários e **bloqueia o intervalo inteiro**, não só o início.
- *"Tanto faz"* escolhe automaticamente o profissional com a agenda mais próxima.
- Fuso horário tratado de verdade (inclusive virada de horário de verão).

## Painel da recepção

- **Hoje**: agenda do dia por profissional, com botões *Confirmar*, *Compareceu*, *Faltou* e *Cancelar*.
- **Fila e urgências**: pacientes que pediram atendente ou dispararam a triagem sobem para o topo, com selo vermelho.
- **Conversas**: histórico em bolhas, ficha do paciente (nascimento, convênio, próxima consulta, status da confirmação), envio manual pela recepção e botão para devolver a conversa ao bot.
- **Simulador**: testa o atendimento inteiro sem conectar o WhatsApp — inclusive o caminho da urgência.
- **Lembretes**: fila do que vai sair, com *enviar agora* e *cancelar*.
- **Números** (abaixo): taxa de falta dos últimos 30 dias, geral e por profissional, e o comparativo
  **confirmou × não confirmou** — que mostra em pontos percentuais quanto o lembrete de véspera
  está segurando de falta. Consultas que passaram sem ninguém marcar presença aparecem à parte e
  ficam fora da conta, em vez de virar "compareceu" por omissão.
- **Ajustes**: dados do consultório, convênios, valores, o que levar e a agenda de cada profissional — tudo editável sem mexer no código.

![aba de números](docs/numeros.png)

## Disparo de mensagens da recepção

Quando você quer falar com um grupo de pacientes — "abrimos horários extras na sexta",
"não abriremos no feriado", "seu retorno está em aberto" — o painel tem a aba **Disparo**:

1. **Separe os números.** Segmentos prontos, com a contagem de cada um:

   | Segmento | Quem entra |
   | --- | --- |
   | Já entraram em contato | Qualquer pessoa que já mandou mensagem |
   | Sem consulta marcada | Já falaram, mas não têm horário futuro |
   | Com consulta marcada | Têm consulta futura na agenda |
   | Aguardando confirmação | Têm consulta futura e ainda não confirmaram |
   | Faltaram alguma vez | Falta registrada pela recepção |
   | Já foram atendidos | Compareceram a pelo menos uma consulta |
   | Sem falar há 30 dias | Último contato há mais de 30 dias |
   | Todos os cadastros | Inclui quem foi cadastrado sem ter escrito |

   Dá para ajustar na mão: cada paciente da lista tem uma caixinha de seleção, e há
   **Selecionar filtro**, **Copiar números** e **Baixar CSV**.

2. **Escreva a mensagem**, com variáveis que o bot preenche por paciente:
   `{primeiro_nome}`, `{nome}`, `{telefone}`, `{convenio}`, `{data_consulta}`, `{hora_consulta}`,
   `{medico}`, `{consultorio}`, `{telefone_consultorio}`, `{endereco}`.
   A prévia mostra o texto já preenchido para os primeiros destinatários.

3. **Dispare agora ou agende** (data e hora). O disparo agendado aparece no histórico e pode ser
   cancelado antes de sair.

![aba de disparo](docs/disparo.png)

### O que o disparo faz por você

- **Nunca envia para quem respondeu "sair"** — mesmo que a pessoa esteja selecionada.
- **Não repete número** dentro do mesmo disparo.
- **Envia espaçado** (padrão: 2,5 s entre mensagens) em vez de rajada, e tem **teto por disparo**
  (padrão: 200). Ajuste em `BROADCAST_DELAY_MS` e `BROADCAST_MAX`.
- **Mostra o progresso** ao vivo (enviadas / falhas / ignoradas) e guarda o histórico.
- Cada mensagem entra no **histórico da conversa** do paciente, como qualquer outra.

> Envio em massa é o caminho mais rápido para o número ser bloqueado pelo WhatsApp. Mande só para
> quem já falou com o consultório e espera notícias suas; nunca para lista comprada.

## Como rodar

```bash
npm install
cp .env.example .env
npm run seed     # opcional: popula com um dia típico de consultório
npm start        # painel em http://localhost:3000
```

Com `CHANNEL=mock` (padrão) nada é enviado de verdade: você conversa com o bot pelo simulador do painel.

### Conectando no WhatsApp

```bash
npm install whatsapp-web.js qrcode-terminal   # dependências opcionais
# no .env:  CHANNEL=whatsapp
npm start
```

Leia o QR Code do terminal em **WhatsApp › Aparelhos conectados**. A sessão fica salva em `.wwebjs_auth/`.

> `whatsapp-web.js` automatiza o WhatsApp Web e **não é API oficial**. Para uso comercial em escala,
> o caminho suportado é a **WhatsApp Cloud API** da Meta. Trocar é simples: crie um adaptador em
> `src/channels/` com `start()`, `sendText(phone, texto)` e o callback `onMessage({ phone, name, body })`.

## Personalizando para o seu consultório

Quase tudo está em dois arquivos:

- **`src/clinic.js`** — nome, especialidade, nome da assistente, endereço, telefone, convênios,
  valores, o que levar, profissionais (com agenda), tipos de atendimento (com duração, preparo e
  prazo de retorno) e políticas (antecedência, tolerância, aviso de privacidade).
- **`src/core/messages.js`** — **todo** o texto que o paciente lê. Quer outro tom, mais formal ou
  mais próximo? Edite aqui; a lógica não muda.

Os dados do consultório e as agendas também podem ser editados pela aba **Ajustes** do painel.

## Configuração (`.env`)

| Variável | Padrão | Para que serve |
| --- | --- | --- |
| `CHANNEL` | `mock` | `mock` (simulador) ou `whatsapp` (QR Code) |
| `PORT` | `3000` | Porta do painel |
| `TZ` | `America/Sao_Paulo` | Fuso da agenda e dos lembretes |
| `TYPING_DELAY_MS` | `1200` | Pausa entre mensagens no canal real (0 desliga) |
| `SCHEDULER_INTERVAL_MS` | `30000` | Frequência com que os lembretes vencidos são enviados |
| `WAIT_TOUCH_MIN_DAYS` | `10` | Silêncio mínimo entre marcar e o primeiro lembrete para valer o toque do meio |
| `BROADCAST_DELAY_MS` | `2500` | Intervalo entre as mensagens de um disparo |
| `BROADCAST_MAX` | `200` | Teto de destinatários por disparo |
| `CHROMIUM_PATH` | — | Caminho do Chromium, se o Puppeteer não achar sozinho |

## API

| Método | Rota | Descrição |
| --- | --- | --- |
| `GET` | `/api/state` | Snapshot completo do painel |
| `GET` | `/api/stream` | Server-Sent Events: atualização em tempo real |
| `POST` | `/api/simulate` | Injeta mensagem do paciente (`{phone, name, body}`) |
| `POST` | `/api/messages` | Mensagem manual da recepção (`{contactId, body}`) |
| `PATCH` | `/api/contacts/:id` | Edita cadastro (nome, nascimento, convênio, prioridade) |
| `POST` | `/api/contacts/:id/release` | Devolve a conversa ao atendimento automático |
| `POST` | `/api/contacts/:id/followups` | Reprograma os lembretes de 1/7/15 dias |
| `GET` | `/api/slots?date=&professionalId=&serviceId=` | Horários livres |
| `GET` | `/api/day?date=` | Agenda do dia por profissional |
| `POST` | `/api/bookings` | Cria consulta |
| `POST` | `/api/bookings/:id/status` | Confirmação de presença e comparecimento/falta |
| `DELETE` | `/api/bookings/:id` | Cancela consulta e seus lembretes |
| `POST` | `/api/reminders/:id/send` | Antecipa um lembrete |
| `DELETE` | `/api/reminders/:id` | Cancela um lembrete |
| `GET` | `/api/metrics?dias=30` | Taxa de falta geral, por profissional e por confirmação |
| `GET` | `/api/segments/:id` | Quem está no segmento (id, nome, telefone, situação) |
| `POST` | `/api/broadcast/preview` | Prévia: quantos recebem, quem fica de fora, texto preenchido |
| `POST` | `/api/broadcast` | Dispara agora ou agenda (`{contactIds, body, scheduledAt}`) |
| `DELETE` | `/api/broadcast/:id` | Cancela um disparo ainda agendado |
| `GET`/`PUT` | `/api/clinic` | Dados do consultório |
| `PUT` | `/api/professionals/:id` | Agenda e dados de um profissional |
| `GET` | `/api/health` | Status do canal e contadores |

## Estrutura

```
src/
  index.js            entrada: painel, canal e agendador de lembretes
  app.js              liga armazenamento, agenda, lembretes, bot e canal
  clinic.js           dados do consultório (médicos, serviços, convênios, políticas)
  config.js           .env + janelas dos lembretes
  server.js           API REST + SSE + painel
  core/bot.js         roteamento da conversa e fluxo de agendamento
  core/messages.js    todo o texto que o paciente lê
  core/nlu.js         intenções, números, horários, datas em português
  core/triage.js      sinais de alarme
  core/agenda.js      fuso, grade de horários, reservas por profissional
  core/broadcast.js   segmentos, variáveis e disparo espaçado
  core/metrics.js     taxa de falta e efeito da confirmação
  core/reminders.js   follow-up, pré-consulta, retorno e falta
  channels/           simulador e WhatsApp real
  db/store.js         persistência em JSON (data/db.json)
public/               painel da recepção (HTML + CSS + JS puros)
test/                 65 testes com node:test
```

## Testes

```bash
npm test
```

Cobrem a triagem de urgência, o entendimento de linguagem natural, a grade de horários por
profissional e duração, as quatro famílias de lembrete, a conversa inteira de agendamento,
remarcação, cancelamento e handoff, e o disparo — segmentação, variáveis, exclusão de opt-out
e de números repetidos, teto por disparo e envio agendado. Também a régua de lembretes nova — o
toque do meio da espera, o check-in do dia seguinte, o encaminhamento da dúvida pós-consulta para
a recepção — e o cálculo da taxa de falta, incluindo o caso em que a presença não foi registrada.

## Próximos passos

Quatro itens do backlog já entraram: confirmação que mostra o horário reservado, toque no meio da
espera, check-in do dia seguinte e taxa de falta no painel. O que falta — régua de follow-up com
propósito por toque, escassez calculada da agenda, resposta completa de preço com dois horários e
biblioteca de conteúdo por tema — está em [`docs/roadmap.md`](docs/roadmap.md), cada um com o
ponto do código onde entra.

## Avisos

- Esta é uma ferramenta de **secretariado**, não um dispositivo médico. Ela não faz triagem clínica,
  não classifica risco e não substitui avaliação profissional.
- Antes de usar com pacientes reais, revise os textos de `src/core/messages.js` com o médico
  responsável, confirme as regras do seu conselho profissional sobre comunicação e publicidade, e
  registre a base legal do tratamento de dados (LGPD) para os telefones e cadastros armazenados.
- Disparo em massa é responsabilidade de quem envia: só mande para pacientes que já procuraram o
  consultório e mantenha o opt-out funcionando (ele já é automático em `sair`).
- Os dados ficam em `data/db.json`, sem criptografia. Para uso real, coloque o serviço atrás de
  autenticação, restrinja o acesso ao painel e faça backup do arquivo.
