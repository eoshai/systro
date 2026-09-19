# 🤖 Bot de Verificação — Shai WZL

Bot para Discord (discord.js v14) que automatiza a verificação de membros a partir de um **print de tela**, confirmando via OCR se o usuário está inscrito no canal **Shai WZL** e liberando um cargo de acesso automaticamente. Conta ainda com aprovação/recusa manual pela staff, sistema honeypot anti-invasão e logs completos.

## ✨ Funcionalidades

- **Verificação automática por OCR**: o usuário envia um print no canal de verificação e o bot extrai o texto da imagem via API do OCR.space.
- **Liberação automática de cargo** quando a verificação é aprovada.
- **Comandos `/aprovar` e `/recusar`** para a staff tratar casos manuais.
- **Notificações por DM** ao usuário (aprovado, recusado ou encaminhado para análise manual).
- **Canal de logs** com embed detalhado de cada verificação (usuário, ID, data, duração, motivo da recusa, etc).
- **Honeypot de segurança**: qualquer mensagem enviada em um canal-armadilha resulta em expulsão automática do autor e limpeza das mensagens.
- **Autolimpeza de mensagens** no canal de verificação (a pergunta do usuário e a resposta do bot são apagadas alguns segundos depois).
- **Presença dinâmica** do bot mostrando a contagem de membros do servidor, atualizada a cada 10 minutos.
- **Deduplicação de eventos** do Gateway do Discord (evita processar a mesma mensagem/interação duas vezes após um *resume* de conexão).
- **Cache otimizado** (mensagens, usuários, membros e presenças não ficam em RAM) para baixo consumo de memória.
- **Rate limit por usuário**: no máximo 3 tentativas de verificação a cada 10 minutos, evitando spam/abuso da API de OCR.
- **Aviso de falhas seguidas**: após 3 recusas seguidas, o bot sugere ao usuário abrir um ticket com a staff.
- **Botões diretos no embed da staff**: quando o OCR falha, o embed de análise manual já vem com botões "Aprovar" e "Recusar" (o de recusar abre um pequeno formulário para o motivo), sem precisar digitar `/aprovar` ou `/recusar` manualmente.
- **`/pendentes`**: lista as verificações aguardando análise manual da staff, com link direto para cada solicitação.
- **`/stats`**: mostra estatísticas de aprovações, recusas e erros de OCR (hoje / 7 dias / total).

## ⚙️ Pré-requisitos

- Node.js 18 ou superior
- Um bot Discord criado no [Discord Developer Portal](https://discord.com/developers/applications), com os seguintes **intents privilegiados** habilitados:
  - `Server Members Intent`
  - `Message Content Intent`
- Uma chave de API do [OCR.space](https://ocr.space/ocrapi) (possui plano gratuito)

## 📦 Instalação

```bash
npm install discord.js dotenv
node index.js
```

## 🔧 Variáveis de ambiente

Crie um arquivo `.env` na raiz do projeto:

| Variável | Obrigatória | Descrição |
|---|---|---|
| `DISCORD_TOKEN` | ✅ | Token do bot Discord |
| `OCR_API_KEY` | ✅ | Chave de API do OCR.space |
| `VERIFICATION_CHANNEL_ID` | ✅ | ID do canal onde os usuários enviam o print para verificação |
| `VERIFIED_ROLE_ID` | ✅ | ID do cargo liberado após a verificação |
| `LOG_CHANNEL_ID` | ✅ | ID do canal onde os logs de verificação são enviados |
| `HONEYPOT_CHANNEL_ID` | ✅ | ID do canal-armadilha (qualquer mensagem nele resulta em kick) |
| `CHANNEL_NAME_VARIANTS` | ✅ | Variações do nome do canal que o OCR deve encontrar no print, separadas por vírgula (ex: `shai wzl,shai_wzl,@shai_wzl,shai-wzl`) |
| `GUILD_ID` | Recomendada | ID do servidor (usado para atualizar a contagem de membros na presença) |
| `STAFF_CHANNEL_ID` | ✅ | Canal para onde vão os pedidos de análise manual (erro de OCR) |
| `STAFF_ROLE_ID` | ✅ | Cargo da equipe de suporte, mencionado nos pedidos de análise manual |
| `ROLES_CHANNEL_ID` | ✅ | Canal onde o usuário reivindica cargos após aprovação pública (`/aprovar visivel:true`) |
| `ROLES_BUTTON_URL` | ✅ | URL usada no botão "Receber os sistemas" da aprovação pública |

> ⚠️ `STAFF_CHANNEL_ID`, `STAFF_ROLE_ID`, `ROLES_CHANNEL_ID`, `ROLES_BUTTON_URL` e `CHANNEL_NAME_VARIANTS` não têm mais valor padrão no código — precisam estar definidas no `.env`. Se `CHANNEL_NAME_VARIANTS` ficar vazia, nenhuma verificação automática vai passar (a checagem do nome do canal nunca encontra correspondência); se as demais ficarem vazias, notificação à staff, botão de cargos, etc. não funcionam corretamente.

## 🧠 Como funciona a verificação automática

1. O usuário envia uma imagem no `VERIFICATION_CHANNEL_ID`.
2. O bot reage com ⏳, baixa o texto da imagem via OCR.space (engine 2, idioma automático, com fallback para português) e apaga a reação ao concluir.
3. O texto extraído é normalizado (removendo acentos, pontuação e caixa) e analisado em busca de:
   - **Nome do canal**: qualquer uma das variações definidas em `CHANNEL_NAME_VARIANTS`.
   - **Palavra de confirmação de inscrição**: `inscrito`, `inscrita`, `suscrito`, `subscribed`, etc. — com uma checagem extra para ignorar falsos positivos como "300 mil inscritos" (número antes da palavra).
4. **Aprovado** (nome do canal + confirmação encontrados): reage ✅, adiciona o cargo, envia DM e log, e responde com um embed de sucesso que se autodestrói (junto da mensagem original) após 7,5 segundos.
5. **Recusado**: reage ❌, informa o(s) motivo(s) da recusa, envia DM e log.
6. **Erro de leitura da imagem** (falha do OCR): reage ⚠️, encaminha o print para o `STAFF_CHANNEL_ID` (mencionando `STAFF_ROLE_ID`) para revisão manual e avisa o usuário por DM e no canal.
7. Imagens acima de **5 MB** são rejeitadas com um aviso (mensagem removida após 15 segundos).
8. Cada usuário tem no máximo **3 tentativas a cada 10 minutos**; ao exceder isso, o bot avisa quanto tempo falta para tentar novamente, sem gastar uma nova chamada de OCR.
9. Após **3 recusas seguidas**, o bot manda um aviso extra sugerindo abrir um ticket com a staff (o contador zera depois do aviso).

## 🛡️ Segurança — Honeypot

Qualquer mensagem enviada no canal definido em `HONEYPOT_CHANNEL_ID` é tratada como violação de segurança: o bot apaga as mensagens recentes do autor naquele canal e o expulsa (`kick`) do servidor imediatamente.

## 🎛️ Comandos de slash (staff)

Ambos os comandos exigem a permissão `Manage Roles`.

### `/aprovar usuario:<usuário> visivel:<true|false>`
Aprova manualmente a verificação de um usuário: adiciona o cargo (se ainda não tiver), envia DM de confirmação e registra o log. Se `visivel` for `true`, também publica um embed público mencionando o usuário, com um botão de link para o canal de cargos.

### `/recusar usuario:<usuário> motivo:<texto>`
Recusa manualmente a verificação, enviando DM ao usuário com o motivo informado (ou um motivo padrão) e registrando o log.

### `/pendentes`
Lista (de forma privada, só para quem executou o comando) as verificações que ainda aguardam análise manual, com o tempo de espera e um link direto para a solicitação no canal da staff.

### `/stats`
Mostra (de forma privada) um resumo com o número de aprovações automáticas, recusas automáticas, aprovações/recusas manuais e erros de OCR, comparando hoje, os últimos 7 dias e o total acumulado desde a última inicialização do bot.

> ⚠️ As estatísticas e a lista de pendentes ficam **em memória** — são perdidas quando o processo reinicia. Para manter esse histórico entre reinícios, seria necessário adicionar um banco (ex.: SQLite).

### Botões no embed de análise manual
Quando o OCR falha em ler uma imagem, o embed enviado ao `STAFF_CHANNEL_ID` já vem com dois botões:
- **✅ Aprovar** — libera o cargo, envia DM e log, e marca a pendência como resolvida direto no embed.
- **❌ Recusar** — abre um pequeno formulário (modal) para a staff informar o motivo antes de recusar.

Ambos os botões exigem que quem clique tenha o cargo `STAFF_ROLE_ID` ou a permissão `Manage Roles` — do contrário, o bot responde com um aviso de permissão negada (visível só para quem clicou).

## ⚠️ Observações importantes

- A deduplicação de eventos protege apenas contra o Discord reenviar o mesmo evento (por exemplo, após um *resume* de conexão) — **não** protege contra duas instâncias do bot rodando simultaneamente com o mesmo token. Garanta que apenas **um processo** esteja ativo por vez.
- Todos os erros não tratados em `messageCreate` são capturados e sinalizados com a reação ⚠️, sem derrubar o processo.
- O bot registra um handler para `unhandledRejection`, evitando que falhas assíncronas encerrem o processo inesperadamente.

## 📁 Estrutura esperada do projeto

```
.
├── index.js
├── .env
└── package.json
```