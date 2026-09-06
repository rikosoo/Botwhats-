# Ligar o painel ao Google Agenda

O médico não abre o painel: ele olha o calendário do celular. Com esta ligação,
a consulta marcada pelo bot ou pela recepção **aparece no Google Agenda dele** —
e, se você quiser, o compromisso que ele marcar no celular **deixa de ser
oferecido** como horário livre ao paciente.

Tudo é feito na aba **⚙️ Ajustes → 📅 Google Agenda**.

---

## Antes de começar: por que preciso criar algo no Google?

Para escrever na agenda de alguém, o Google exige uma credencial **do próprio
consultório** (um "cliente OAuth"). Não existe atalho: nenhum aplicativo pode
emprestar a credencial dele para gravar na sua conta. É de graça, leva uns dez
minutos e se faz **uma vez só**.

Você vai sair de lá com dois valores:

- **ID do cliente** — algo como `938271...-abc123.apps.googleusercontent.com`
- **Chave secreta do cliente** — algo como `GOCSPX-...`

---

## 1. Criar o projeto e a credencial no Google Cloud

1. Entre em <https://console.cloud.google.com/> com a conta do Google **que tem
   a agenda do consultório**.
2. No topo, clique no seletor de projeto → **Novo projeto**. Nome: `Consultorio`.
   Criar.
3. Menu → **APIs e serviços → Biblioteca**. Busque **Google Calendar API** e
   clique em **Ativar**.
4. Menu → **APIs e serviços → Tela de permissão OAuth**:
   - Tipo: **Externo** → Criar.
   - Nome do app: `Painel do consultório`. E-mail de suporte e e-mail do
     desenvolvedor: o seu.
   - Em **Usuários de teste**, adicione o e-mail da conta do consultório. Sem
     isso o Google recusa a autorização.
   - Salvar. **Não precisa publicar o app** nem passar por verificação: em modo
     de teste, os usuários que você listou funcionam normalmente.
5. Menu → **APIs e serviços → Credenciais → Criar credenciais → ID do cliente
   OAuth**:
   - Tipo de aplicativo: **Aplicativo da Web**.
   - Nome: `Painel`.
   - Em **URIs de redirecionamento autorizados**, clique em *Adicionar URI* e
     cole exatamente o que o painel mostra no campo "URL de redirecionamento
     autorizada" — por padrão:

     ```
     http://localhost:3000/api/google/callback
     ```

     > O Google aceita `http://localhost` com qualquer porta, mas **não aceita
     > endereço de IP** (`http://18.219.126.21/...` é recusado). Por isso o
     > padrão é localhost — e o painel tem um caminho para quando a volta do
     > Google não abre (passo 3 abaixo).

   - Criar. Copie o **ID do cliente** e a **chave secreta**.

## 2. Guardar as credenciais no painel

No painel, em **Ajustes → Google Agenda**:

1. Cole o **ID do cliente** e a **chave secreta**.
2. Confira a **URL de redirecionamento** (tem que ser idêntica à do Google Cloud).
3. **Salvar credenciais**.

A chave secreta nunca volta para a tela — o painel mostra só `•••••• (guardada)`.
Ela fica em `data/db.json`, no servidor.

## 3. Conectar

Clique em **🔗 Conectar com o Google**. Abre uma aba do Google pedindo permissão
para a agenda. Autorize com a conta do consultório.

O que acontece depois depende de como você abre o painel:

- **Pelo túnel SSH** (`ssh -L 3000:localhost:3000 ...`, painel em
  `http://localhost:3000`): o Google devolve o navegador direto para o painel e
  aparece *"Google Agenda conectado"*. Acabou.
- **Por outro endereço** (o IP do servidor, por exemplo): o navegador vai mostrar
  um erro do tipo *"não é possível acessar esse site"* na volta. **Isso é
  esperado** — o código veio junto, na barra de endereço. Copie a barra de
  endereço inteira, cole no campo *"Deu erro na volta? Cole aqui o endereço da
  barra do navegador"* e clique em **Concluir conexão**.

Na conexão, as consultas futuras que já existiam sobem de uma vez para o
calendário.

## 4. O que dá para ajustar

| Opção | O que faz |
| --- | --- |
| **Mandar as consultas para o Google Agenda** | Liga e desliga o envio sem desconectar a conta. |
| **Não oferecer horários que já estão ocupados no Google** | O caminho de volta: o painel relê o calendário a cada 5 minutos e trata os compromissos como horário ocupado. Eventos marcados como *disponível* no Google não contam, e os eventos criados pelo próprio painel não contam duas vezes. |
| **Este calendário é de qual profissional?** | Só aparece com mais de um médico cadastrado. Uma conta do Google não deve bloquear a agenda de todo mundo. |
| **Trocar de calendário** | Lista os calendários em que a conta pode escrever. |
| **Reenviar consultas futuras** | Manda de novo tudo que está marcado daqui para frente — útil depois de trocar de calendário. |
| **Desconectar** | Revoga o acesso no Google e apaga o que estava guardado aqui. As consultas já enviadas continuam no calendário. |

## Como o evento fica

- **Título**: `Marina Alves — Primeira consulta`
- **Descrição**: paciente, WhatsApp, tipo de atendimento, profissional, convênio
  (ou "Particular") e se a presença já foi confirmada.
- **Duração**: a do tipo de atendimento (40 min para primeira consulta, 20 para
  retorno, e assim por diante).

Remarcar, confirmar ou cancelar no painel muda o evento no Google. Cancelou, o
evento some. Se alguém apagar o evento à mão no celular, o painel recria na
próxima alteração daquela consulta — a agenda do consultório é a verdade; o
Google é a cópia conveniente.

## Quando algo dá errado

O painel mostra a última falha embaixo de *"Conectado"*. As mais comuns:

| Mensagem | O que fazer |
| --- | --- |
| `The OAuth client was not found` | O ID do cliente está errado ou é de outro projeto. |
| `redirect_uri_mismatch` (na tela do Google) | A URL de redirecionamento do painel e a do Google Cloud precisam ser idênticas, incluindo a porta. |
| `access_denied` / conta não autorizada | Falta adicionar o e-mail em **Usuários de teste** na tela de permissão OAuth. |
| `invalid_grant` | O código já foi usado ou passou do prazo. Clique em **Conectar com o Google** de novo. |
| `O Google não devolveu a autorização de longo prazo` | Refaça pelo botão do painel (ele pede o consentimento outra vez, que é o que devolve o acesso permanente). |

Uma falha no Google **nunca derruba a consulta**: ela fica marcada aqui, o erro
vai para a aba Atividade e a próxima alteração tenta de novo.

## Segurança

- A chave secreta e o token de acesso ficam só no servidor, em `data/db.json`.
  Nem um nem outro são enviados para a tela.
- O painel pede o escopo de calendário e mais nada — não lê e-mail, contatos ou
  arquivos.
- **Desconectar** revoga o acesso do lado do Google, não só apaga daqui. Você
  também pode revogar a qualquer momento em
  <https://myaccount.google.com/permissions>.
