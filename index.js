require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  Options,
  PermissionFlagsBits,
  SlashCommandBuilder,
  ActivityType,
  MessageFlags,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

// ---------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OCR_API_KEY = process.env.OCR_API_KEY;
const VERIFICATION_CHANNEL_ID = process.env.VERIFICATION_CHANNEL_ID;
const VERIFIED_ROLE_ID = process.env.VERIFIED_ROLE_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const HONEYPOT_CHANNEL_ID = process.env.HONEYPOT_CHANNEL_ID;
const GUILD_ID = process.env.GUILD_ID;

// IDs do Chat da Staff e Cargo da Equipe de Suporte
const STAFF_CHANNEL_ID = process.env.STAFF_CHANNEL_ID;
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID;

// Canal onde o usuário reivindica os cargos após a aprovação pública (/aprovar visivel:true)
const ROLES_CHANNEL_ID = process.env.ROLES_CHANNEL_ID;
const ROLES_BUTTON_URL =
  process.env.ROLES_BUTTON_URL;

// Configurações adicionais
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // Limite de 5MB por imagem
const RESULT_CLEANUP_DELAY_MS = 7500;
const WARNING_CLEANUP_DELAY_MS = 15000; // avisos ("envie um print", "limite atingido"...)

// Tempo máximo de espera por chamada à API de OCR (depois disso cai para revisão manual)
const OCR_TIMEOUT_MS = 30 * 1000;

// Quantas pendências o /pendentes lista de uma vez
const PENDING_LIST_LIMIT = 15;

// Honeypot: quanto do histórico do usuário banido é apagado (padrão 1h; máx. do Discord: 7 dias).
// Pode ser ajustado com HONEYPOT_DELETE_SECONDS no .env.
const HONEYPOT_MAX_DELETE_SECONDS = 7 * 24 * 60 * 60;
const parsedDeleteSeconds = parseInt(process.env.HONEYPOT_DELETE_SECONDS ?? '', 10);
const HONEYPOT_DELETE_SECONDS = Number.isNaN(parsedDeleteSeconds)
  ? 60 * 60
  : Math.min(Math.max(parsedDeleteSeconds, 0), HONEYPOT_MAX_DELETE_SECONDS);

const ROLE_ERROR_MESSAGE =
  '⚠️ Não consegui atribuir o cargo de verificado. Confira se o cargo do bot está acima dele na hierarquia e se o bot tem a permissão **Gerenciar Cargos**.';

// Rate limit de tentativas de verificação (evita spam/abuso do OCR)
const RATE_LIMIT_MAX_ATTEMPTS = 3;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutos

// Após quantas recusas seguidas o bot sugere abrir um ticket com a staff
const MAX_CONSECUTIVE_FAILURES = 3;

if (!DISCORD_TOKEN) {
  console.error('[ERRO FATAL] DISCORD_TOKEN não definido no .env. Encerrando bot.');
  process.exit(1);
}

const CHANNEL_NAME_VARIANTS = (process.env.CHANNEL_NAME_VARIANTS || '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

// Avisos de configuração incompleta (não são fatais, mas quebram partes do fluxo)
const RECOMMENDED_ENV = {
  OCR_API_KEY,
  VERIFICATION_CHANNEL_ID,
  VERIFIED_ROLE_ID,
  LOG_CHANNEL_ID,
  STAFF_CHANNEL_ID,
  STAFF_ROLE_ID,
};
for (const [name, value] of Object.entries(RECOMMENDED_ENV)) {
  if (!value) console.warn(`[CONFIG] ${name} não definido no .env — parte do fluxo pode não funcionar.`);
}
if (CHANNEL_NAME_VARIANTS.length === 0) {
  console.warn('[CONFIG] CHANNEL_NAME_VARIANTS vazio — nenhuma verificação automática será aprovada.');
}

const CONFIRMATION_WORDS = [
  'inscrito',
  'inscrita',
  'nscrito',
  'nscrita',
  'suscrito',
  'suscrita',
  'suscripto',
  'subscribed',
];

const NOT_SUBSCRIBED_WORDS = [
  'se inscrever',
  'inscrever-se',
  'inscreva-se',
  'suscribirse',
  'subscribe',
];

// ---------------------------------------------------------------------
// Utilidades de texto e agendamento
// ---------------------------------------------------------------------

function normalize(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9@_\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsAny(normalizedText, list) {
  return list.some((term) => normalizedText.includes(normalize(term)));
}

function hasConfirmationWord(normalizedText) {
  for (const word of CONFIRMATION_WORDS) {
    const regex = new RegExp(`(.{0,20})\\b${word}\\b`, 'g');
    let match;
    while ((match = regex.exec(normalizedText)) !== null) {
      const context = match[1];
      const precededByNumber = /(\d[\d.,]*\s*(mil|milhoes|milhões|mi|k|m)?\s*)$/.test(context);
      if (!precededByNumber) return true;
    }
  }
  return false;
}

function scheduleMessageCleanup(userMessage, botResponse, delayMs = RESULT_CLEANUP_DELAY_MS) {
  setTimeout(async () => {
    await userMessage.delete().catch(() => {});
    await botResponse.delete().catch(() => {});
  }, delayMs);
}

// Responde a mensagem do usuário com um aviso e apaga os dois depois de um tempo
async function replyAndCleanup(message, content, delayMs = WARNING_CLEANUP_DELAY_MS) {
  const aviso = await message.reply(content);
  scheduleMessageCleanup(message, aviso, delayMs);
  return aviso;
}

// 90 min -> "1h30min" | 45 min -> "45min"
function formatWaitTime(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 60) return `${totalMinutes}min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h${minutes}min` : `${hours}h`;
}

// 3600 -> "1 hora(s)" | 86400 -> "1 dia(s)" | 0 -> "nenhum"
function formatDuration(totalSeconds) {
  if (totalSeconds <= 0) return 'nenhum';
  if (totalSeconds % 86400 === 0) return `${totalSeconds / 86400} dia(s)`;
  if (totalSeconds % 3600 === 0) return `${totalSeconds / 3600} hora(s)`;
  if (totalSeconds % 60 === 0) return `${totalSeconds / 60} min`;
  return `${totalSeconds}s`;
}

// ---------------------------------------------------------------------
// Deduplicação de eventos
// Proteção contra o Discord Gateway despachando o mesmo evento mais de
// uma vez (ex.: após um resume de conexão). Isto NÃO protege contra duas
// instâncias/processos do bot rodando ao mesmo tempo com o mesmo token —
// isso precisa ser resolvido garantindo que só 1 processo esteja ativo.
// ---------------------------------------------------------------------
const processedMessageIds = new Set();
const processedInteractionIds = new Set();

function markProcessedOnce(set, id, ttlMs = 60000) {
  if (set.has(id)) return false;
  set.add(id);
  setTimeout(() => set.delete(id), ttlMs);
  return true;
}

// ---------------------------------------------------------------------
// Estado em memória (rate limit, falhas seguidas, pendências e stats)
// NOTA: tudo aqui é perdido quando o processo reinicia. Se precisar que
// isso persista entre reinícios, isso deve ser movido para um banco
// (ex.: SQLite) — hoje o bot não usa nenhuma persistência em disco.
// ---------------------------------------------------------------------
const verificationAttempts = new Map(); // userId -> timestamps[] das últimas tentativas
const consecutiveFailures = new Map(); // userId -> nº de recusas seguidas
const pendingManualReviews = new Map(); // messageId (embed na staff) -> dados da pendência
const statsEvents = []; // { type, timestamp } de cada evento de verificação

function isRateLimited(userId) {
  const now = Date.now();
  const attempts = (verificationAttempts.get(userId) || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  verificationAttempts.set(userId, attempts);
  return attempts.length >= RATE_LIMIT_MAX_ATTEMPTS;
}

function registerAttempt(userId) {
  const attempts = verificationAttempts.get(userId) || [];
  attempts.push(Date.now());
  verificationAttempts.set(userId, attempts);
}

function getRateLimitResetSeconds(userId) {
  const attempts = verificationAttempts.get(userId) || [];
  if (attempts.length === 0) return 0;
  const oldest = Math.min(...attempts);
  return Math.max(0, Math.ceil((RATE_LIMIT_WINDOW_MS - (Date.now() - oldest)) / 1000));
}

function registerFailure(userId) {
  const count = (consecutiveFailures.get(userId) || 0) + 1;
  consecutiveFailures.set(userId, count);
  return count;
}

function resetFailures(userId) {
  consecutiveFailures.delete(userId);
}

// Remove usuários cujas tentativas já expiraram, para o Map não crescer indefinidamente
function sweepExpiredAttempts() {
  const now = Date.now();
  for (const [userId, timestamps] of verificationAttempts) {
    if (timestamps.every((t) => now - t >= RATE_LIMIT_WINDOW_MS)) {
      verificationAttempts.delete(userId);
    }
  }
}

// O cache de membros está desabilitado (poupa RAM), então buscamos na API quando preciso
async function fetchMember(guild, userId) {
  return guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
}

function hasVerifiedRole(member) {
  return Boolean(VERIFIED_ROLE_ID && member?.roles.cache.has(VERIFIED_ROLE_ID));
}

// Retorna true se o membro já tem (ou passou a ter) o cargo; false se a atribuição falhou
async function grantVerifiedRole(member) {
  if (!VERIFIED_ROLE_ID) return true;
  if (member.roles.cache.has(VERIFIED_ROLE_ID)) return true;

  try {
    await member.roles.add(VERIFIED_ROLE_ID);
    return true;
  } catch (err) {
    console.error('[CARGO ERRO]', err.message);
    return false;
  }
}

function recordStatEvent(type) {
  statsEvents.push({ type, timestamp: Date.now() });
}

function countStatEvents(type, sinceMs = null) {
  const since = sinceMs ? Date.now() - sinceMs : 0;
  return statsEvents.filter((e) => e.type === type && e.timestamp >= since).length;
}

async function sendDMNotification(user, approved, motivo = '') {
  try {
    const embed = new EmbedBuilder()
      .setColor(approved ? 0x2ecc71 : 0xe74c3c)
      .setTitle(approved ? '✅ Verificação Concluída' : '❌ Verificação Recusada')
      .setDescription(
        approved
          ? 'Sua inscrição no canal **Shai WZL** foi confirmada e seu acesso liberado!'
          : `Não foi possível aprovar sua verificação.\n**Motivo:** ${motivo}`
      )
      .setTimestamp();

    await user.send({ embeds: [embed] });
  } catch (err) {
    // Falha silenciosa caso o usuário esteja com DMs fechadas
  }
}

// ---------------------------------------------------------------------
// Solicitacao de Aprovação Manual (Enviar para a Staff)
// ---------------------------------------------------------------------

async function notifyStaffForManualReview(client, user, imageUrl) {
  try {
    const staffChannel = await client.channels.fetch(STAFF_CHANNEL_ID).catch(() => null);
    if (!staffChannel) return null;

    const embed = new EmbedBuilder()
      .setTitle('⚠️ Solicitação de Aprovação Manual')
      .setDescription(
        `Ocorreu um erro durante a verificação do membro <@${user.id}> (ID \`${user.id}\`). O bot solicita inspeção manual.`
      )
      .setImage(imageUrl)
      .setColor('#a7a335')
      .setFooter({
        text: 'Print enviada',
      })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`staff_approve:${user.id}`)
        .setLabel('Aprovar')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`staff_reject:${user.id}`)
        .setLabel('Recusar')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Danger)
    );

    const sentMessage = await staffChannel.send({
      content: `<@&${STAFF_ROLE_ID}>`,
      embeds: [embed],
      components: [row],
    });

    pendingManualReviews.set(sentMessage.id, {
      userId: user.id,
      username: user.tag || user.username,
      channelId: staffChannel.id,
      requestedAt: Date.now(),
    });

    return sentMessage;
  } catch (err) {
    console.error('[STAFF NOTIFY ERRO] Falha ao enviar solicitação para a staff:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------
// Gestão de pendências
// ---------------------------------------------------------------------

// Encerra todas as solicitações manuais abertas de um usuário: remove do Map
// (some do /pendentes) e desativa os botões na mensagem da staff. Usado quando o
// caso foi resolvido por outro caminho (/aprovar, /recusar, outro botão) ou
// quando o usuário saiu do servidor.
async function closePendingReviewsForUser(client, userId, { color, footerText }) {
  const entries = [...pendingManualReviews.entries()].filter(([, data]) => data.userId === userId);

  for (const [messageId, data] of entries) {
    pendingManualReviews.delete(messageId);

    try {
      const channel = await client.channels.fetch(data.channelId);
      const staffMessage = await channel.messages.fetch(messageId);
      const embed = staffMessage.embeds[0]
        ? EmbedBuilder.from(staffMessage.embeds[0])
        : new EmbedBuilder();

      embed.setColor(color).setFooter({ text: footerText });
      await staffMessage.edit({ embeds: [embed], components: [] });
    } catch (err) {
      // Mensagem apagada ou sem acesso ao canal: a pendência já saiu do Map
    }
  }
}

// Confere se a mensagem da staff ainda existe e ainda tem os botões ativos
async function isPendingStillOpen(client, messageId, data) {
  try {
    const channel = await client.channels.fetch(data.channelId);
    const staffMessage = await channel.messages.fetch(messageId);
    return staffMessage.components.length > 0;
  } catch (err) {
    // 10008 = Unknown Message | 10003 = Unknown Channel
    if (err.code === 10008 || err.code === 10003) return false;
    return true; // erro temporário (rede, rate limit): mantém a pendência
  }
}

// ---------------------------------------------------------------------
// Envio do Embed de Logs
// ---------------------------------------------------------------------

async function sendLogEmbed(client, user, passed, durationSeconds, motivos = [], moderator = null) {
  try {
    const logChannel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (!logChannel) return;

    const timestampSec = Math.floor(Date.now() / 1000);

    const logEmbed = new EmbedBuilder()
      .setColor(passed ? 0x2bd6fb : 0xe74c3c)
      .setTitle(passed ? 'Verificação Aprovada' : 'Verificação Recusada')
      .addFields(
        {
          name: '👤 Usuário',
          value: `<@${user.id}>\n(\`${user.username}\`)`,
          inline: true,
        },
        {
          name: '🆔 ID',
          value: `\`${user.id}\``,
          inline: true,
        },
        {
          name: '📅 Data',
          value: `<t:${timestampSec}:f>`,
          inline: true,
        }
      );

    if (durationSeconds) {
      logEmbed.addFields({
        name: '⏱️ Duração',
        value: `\`${durationSeconds}s\``,
        inline: true,
      });
    }

    if (moderator) {
      logEmbed.addFields({
        name: '🛡️ Verificação Manual',
        value: `Feita por <@${moderator.id}>`,
        inline: false,
      });
    }

    if (!passed && motivos.length > 0) {
      logEmbed.addFields({
        name: '❓ Motivo da Recusa',
        value: motivos.join('\n'),
        inline: false,
      });
    }

    logEmbed.setThumbnail(user.displayAvatarURL({ size: 256 }));
    logEmbed.setFooter({ text: 'Sistema de Verificação' }).setTimestamp();

    await logChannel.send({ embeds: [logEmbed] });
  } catch (err) {
    console.error('[LOG ERRO] Falha ao enviar log para o canal do Discord:', err.message);
  }
}

// ---------------------------------------------------------------------
// Log do Honeypot
// ---------------------------------------------------------------------

async function sendHoneypotLog(client, message, { banned, errorMessage = null }) {
  try {
    const logChannel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (!logChannel) return;

    const { author } = message;
    const preview = (message.content || '').slice(0, 900).replace(/`/g, "'");

    const embed = new EmbedBuilder()
      .setColor(banned ? 0xe74c3c : 0xf39c12)
      .setTitle(banned ? '🍯 Honeypot — usuário banido' : '🍯 Honeypot — falha ao banir')
      .addFields(
        { name: '👤 Usuário', value: `<@${author.id}>\n(\`${author.username}\`)`, inline: true },
        { name: '🆔 ID', value: `\`${author.id}\``, inline: true },
        { name: '📍 Canal', value: `<#${message.channel.id}>`, inline: true },
        {
          name: '💬 Mensagem',
          value: preview ? `\`\`\`\n${preview}\n\`\`\`` : '*(sem texto — possivelmente só anexos)*',
        }
      )
      .setThumbnail(author.displayAvatarURL({ size: 256 }))
      .setFooter({ text: 'Sistema de Segurança' })
      .setTimestamp();

    if (banned) {
      embed.addFields({
        name: '🧹 Histórico apagado',
        value: formatDuration(HONEYPOT_DELETE_SECONDS),
        inline: true,
      });
    } else {
      embed.addFields({
        name: '⚠️ Erro',
        value: `${errorMessage || 'desconhecido'}\nVerifique a permissão **Banir Membros** e a hierarquia de cargos do bot.`,
      });
    }

    await logChannel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[LOG HONEYPOT ERRO]', err.message);
  }
}

// ---------------------------------------------------------------------
// Embed público de aprovação (/aprovar visivel:true)
// Usado quando a staff aprova alguém manualmente fora do canal de
// verificação (ex.: respondendo a um print em um ticket).
// ---------------------------------------------------------------------

async function sendPublicApprovalEmbed(interaction, targetUser) {
  const embed = new EmbedBuilder()
    .setColor(3455804)
    .setDescription(
      'Verificação concluída com sucesso!\n' +
        `- Agora, para obter acesso ao sistema, basta visitar o canal <#${ROLES_CHANNEL_ID}> e reivindicar seus cargos.`
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setURL(ROLES_BUTTON_URL)
      .setLabel('Receber os sistemas')
      .setEmoji('📋')
  );

  return interaction.followUp({
    content: `<@${targetUser.id}>`,
    embeds: [embed],
    components: [row],
  });
}

// ---------------------------------------------------------------------
// Chamada à API do OCR.space
// ---------------------------------------------------------------------

async function ocrFromImageUrl(imageUrl, language = 'auto') {
  const params = new URLSearchParams({
    apikey: OCR_API_KEY,
    url: imageUrl,
    language,
    OCREngine: '2',
    scale: 'true',
    isOverlayRequired: 'false',
  });

  const endpoint = `https://api.ocr.space/parse/imageurl?${params.toString()}`;

  // Timeout evita que o handler fique pendurado se a API do OCR travar
  const response = await fetch(endpoint, {
    method: 'GET',
    signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`OCR.space respondeu HTTP ${response.status}`);

  const data = await response.json();
  if (data.IsErroredOnProcessing) {
    const msg = Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join('; ') : data.ErrorMessage;
    throw new Error(`OCR.space retornou erro: ${msg || 'desconhecido'}`);
  }

  return (data.ParsedResults || []).map((r) => r.ParsedText || '').join('\n');
}

async function extractTextFromAttachment(attachmentUrl) {
  try {
    const text = await ocrFromImageUrl(attachmentUrl, 'auto');
    if (text && text.trim().length > 0) return text;
  } catch (err) {
    console.warn(`[OCR] Fallback acionado: ${err.message}`);
  }

  // Segunda tentativa forçando português (erros aqui sobem para o chamador)
  return ocrFromImageUrl(attachmentUrl, 'por');
}

function evaluateOcrText(rawText) {
  const text = normalize(rawText);
  const foundChannelName = containsAny(text, CHANNEL_NAME_VARIANTS);
  const foundSubscribedWord = hasConfirmationWord(text);
  const foundNegative = containsAny(text, NOT_SUBSCRIBED_WORDS);

  return {
    passed: foundChannelName && foundSubscribedWord,
    foundChannelName,
    foundSubscribedWord,
    foundNegative,
    rawText,
  };
}

// ---------------------------------------------------------------------
// Cliente Discord otimizado (Poupa-RAM)
// ---------------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel],
  makeCache: Options.cacheWithLimits({
    MessageManager: 0,
    UserManager: 0,
    GuildMemberManager: 0,
    ReactionManager: 0,
    ThreadManager: 0,
    GuildBanManager: 0,
    PresenceManager: 0,
    VoiceStateManager: 0,
  }),
  sweepers: {
    ...Options.DefaultSweeperSettings,
    messages: {
      interval: 60,
      lifetime: 10,
    },
  },
});

// Rede de segurança: evita que erros não tratados derrubem o processo inteiro.
// discord.js re-emite promises rejeitadas dentro de handlers como um evento
// 'error' no Client; sem um listener aqui, o Node trata isso como fatal.
client.on('error', (err) => {
  console.error('[CLIENT ERRO]', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED REJECTION]', err);
});

// Registrar Slash Commands ao ligar o Bot
client.once('ready', async () => {
  console.log(`[INÍCIO] Bot online como: ${client.user.tag}`);

  // Função para atualizar a presença com a contagem real de membros
  const updatePresence = async () => {
    try {
      // Pega a guilda do bot (se você souber o GUILD_ID usa fetch, se não, pega a primeira)
      const guild = GUILD_ID 
        ? await client.guilds.fetch(GUILD_ID).catch(() => null) 
        : client.guilds.cache.first();

      if (guild) {
        // fetch() na guilda atualiza o memberCount sem carregar os membros na RAM
        const fullGuild = await guild.fetch();
        const memberCount = fullGuild.memberCount;

        client.user.setActivity({
          name: `🛠️ Shai | 👥 ${memberCount} membros`,
          type: ActivityType.Playing, // Define como "Jogando"
        });
      }
    } catch (err) {
      console.error('[PRESENÇA ERRO] Falha ao atualizar status:', err.message);
    }
  };

  // Executa imediatamente ao ligar
  await updatePresence();

  // Atualiza a contagem a cada 10 minutos (600.000 ms)
  setInterval(updatePresence, 600000);

  // Limpa tentativas de rate limit já expiradas (evita crescimento do Map)
  setInterval(sweepExpiredAttempts, RATE_LIMIT_WINDOW_MS);

  // Registro dos Slash Commands...
  const commands = [
    new SlashCommandBuilder()
      .setName('aprovar')
      .setDescription('Aprova manualmente um usuário na verificação')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addUserOption((option) =>
        option.setName('usuario').setDescription('Usuário a ser aprovado').setRequired(true)
      )
      .addBooleanOption((option) =>
        option
          .setName('visivel')
          .setDescription('Enviar confirmação pública mencionando o usuário (ex: em tickets). Padrão: não.')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('recusar')
      .setDescription('Recusa manualmente um usuário na verificação')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addUserOption((option) =>
        option.setName('usuario').setDescription('Usuário a ser recusado').setRequired(true)
      )
      .addStringOption((option) =>
        option.setName('motivo').setDescription('Motivo da recusa').setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('pendentes')
      .setDescription('Lista as verificações aguardando análise manual da staff')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

    new SlashCommandBuilder()
      .setName('stats')
      .setDescription('Mostra estatísticas do sistema de verificação')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
  ];

  try {
    await client.application.commands.set(commands);
    console.log('[SLASH] Comandos manuais (/aprovar, /recusar, /pendentes, /stats) registrados!');
  } catch (err) {
    console.error('[SLASH ERRO] Falha ao registrar comandos:', err.message);
  }
});

// Usuário saiu do servidor: encerra as pendências dele para não sobrarem em /pendentes
client.on('guildMemberRemove', async (member) => {
  if (GUILD_ID && member.guild.id !== GUILD_ID) return;

  await closePendingReviewsForUser(client, member.id, {
    color: 0x95a5a6,
    footerText: '🚪 Usuário saiu do servidor — solicitação encerrada',
  }).catch((err) => console.error('[PENDÊNCIA ERRO]', err.message));
});

// ---------------------------------------------------------------------
// Handler de Comandos Slash (Verificação Manual)
// ---------------------------------------------------------------------
// Verifica se quem clicou/interagiu tem permissão de staff (cargo ou Manage Roles)
function isStaffMember(member) {
  if (!member) return false;
  if (STAFF_ROLE_ID && member.roles.cache.has(STAFF_ROLE_ID)) return true;
  return member.permissions.has(PermissionFlagsBits.ManageRoles);
}

async function handleInteraction(interaction) {
  if (!markProcessedOnce(processedInteractionIds, interaction.id)) return;

  // -----------------------------------------------------------------
  // Comandos Slash
  // -----------------------------------------------------------------
  if (interaction.isChatInputCommand()) {
    const { commandName, options, guild } = interaction;

    if (commandName === 'aprovar' || commandName === 'recusar') {
      // Acknowledge the interaction immediately (within Discord's 3s window).
      // Everything below can be slow (member fetch, role add, DM, log embed),
      // so we defer first and use editReply() from here on instead of reply().
      try {
        await interaction.deferReply();
      } catch (err) {
        console.error('[DEFER ERRO]', err.message);
        return; // token already dead, nothing more we can do
      }

      const targetUser = options.getUser('usuario');

      if (commandName === 'aprovar') {
        // Aprovar exige o membro no servidor (ele precisa receber o cargo)
        const member = await fetchMember(guild, targetUser.id);

        if (!member) {
          return interaction.editReply({ content: '❌ Usuário não encontrado no servidor.' });
        }

        if (!(await grantVerifiedRole(member))) {
          return interaction.editReply({ content: ROLE_ERROR_MESSAGE });
        }

        const visivel = options.getBoolean('visivel') ?? false;

        await sendDMNotification(targetUser, true);
        await sendLogEmbed(client, targetUser, true, null, [], interaction.user);
        recordStatEvent('manual_approved');
        resetFailures(targetUser.id);

        // Encerra solicitações pendentes desse usuário (tira dos /pendentes e desativa os botões)
        await closePendingReviewsForUser(client, targetUser.id, {
          color: 0x2ecc71,
          footerText: `✅ Aprovado por ${interaction.user.tag} (via /aprovar)`,
        });

        if (visivel) {
          await sendPublicApprovalEmbed(interaction, targetUser).catch((err) =>
            console.error('[EMBED PÚBLICO ERRO]', err.message)
          );
        }

        return interaction.editReply({
          content: `✅ <@${targetUser.id}> aprovado manualmente com sucesso por <@${interaction.user.id}>.`,
        });
      }

      // /recusar: não exige que o usuário ainda esteja no servidor, assim a staff
      // consegue limpar pendências de quem já saiu.
      const motivo = options.getString('motivo') || 'Recusado manualmente pela moderação.';

      await sendDMNotification(targetUser, false, motivo);
      await sendLogEmbed(client, targetUser, false, null, [motivo], interaction.user);
      recordStatEvent('manual_rejected');

      await closePendingReviewsForUser(client, targetUser.id, {
        color: 0xe74c3c,
        footerText: `❌ Recusado por ${interaction.user.tag} (via /recusar)`,
      });

      return interaction.editReply({
        content: `❌ Verificação de <@${targetUser.id}> recusada por <@${interaction.user.id}>.`,
      });
    }

    if (commandName === 'pendentes') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      // Descarta pendências cuja mensagem foi apagada ou já foi resolvida por outro caminho
      const entries = [...pendingManualReviews.entries()];
      const stillOpen = await Promise.all(
        entries.map(([messageId, data]) => isPendingStillOpen(client, messageId, data))
      );
      entries.forEach(([messageId], index) => {
        if (!stillOpen[index]) pendingManualReviews.delete(messageId);
      });

      if (pendingManualReviews.size === 0) {
        return interaction.editReply('✅ Não há verificações pendentes no momento.');
      }

      const sorted = [...pendingManualReviews.entries()].sort(
        (a, b) => a[1].requestedAt - b[1].requestedAt
      );

      const linhas = sorted.slice(0, PENDING_LIST_LIMIT).map(([messageId, data]) => {
        const link = `https://discord.com/channels/${guild.id}/${data.channelId}/${messageId}`;
        const espera = formatWaitTime(Date.now() - data.requestedAt);
        return `• <@${data.userId}> — aguardando há **${espera}** — [ver solicitação](${link})`;
      });

      if (sorted.length > PENDING_LIST_LIMIT) {
        linhas.push(`\n… e mais **${sorted.length - PENDING_LIST_LIMIT}** pendência(s) mais recentes.`);
      }

      const embed = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle(`⏳ Verificações pendentes (${sorted.length})`)
        .setDescription(linhas.join('\n'))
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    if (commandName === 'stats') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const DIA_MS = 24 * 60 * 60 * 1000;
      const SEMANA_MS = 7 * DIA_MS;

      const linhaStats = (label, type) =>
        `**${label}**: hoje \`${countStatEvents(type, DIA_MS)}\` · 7 dias \`${countStatEvents(
          type,
          SEMANA_MS
        )}\` · total \`${countStatEvents(type)}\``;

      const embed = new EmbedBuilder()
        .setColor(0x2bd6fb)
        .setTitle('📊 Estatísticas de Verificação')
        .setDescription(
          [
            linhaStats('✅ Aprovados (automático)', 'auto_approved'),
            linhaStats('❌ Recusados (automático)', 'auto_rejected'),
            linhaStats('🛡️ Aprovados (manual)', 'manual_approved'),
            linhaStats('🛡️ Recusados (manual)', 'manual_rejected'),
            linhaStats('⚠️ Erros de OCR', 'ocr_error'),
            `\n⏳ Pendentes agora: \`${pendingManualReviews.size}\``,
          ].join('\n')
        )
        .setFooter({ text: 'Estatísticas contabilizadas desde a última inicialização do bot' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    return;
  }

  // -----------------------------------------------------------------
  // Botões "Aprovar" / "Recusar" no embed de análise manual (staff)
  // -----------------------------------------------------------------
  if (interaction.isButton()) {
    const [action, userId] = interaction.customId.split(':');
    if (action !== 'staff_approve' && action !== 'staff_reject') return;

    if (!isStaffMember(interaction.member)) {
      return interaction.reply({
        content: '❌ Você não tem permissão para usar este botão.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (action === 'staff_approve') {
      await interaction.deferUpdate();

      const targetUser = await client.users.fetch(userId).catch(() => null);
      const member = targetUser ? await fetchMember(interaction.guild, userId) : null;

      if (!member || !targetUser) {
        return interaction.followUp({
          content: '❌ Usuário não encontrado no servidor.',
          flags: MessageFlags.Ephemeral,
        });
      }

      // Se o cargo falhar, a solicitação continua aberta para a staff tentar de novo
      if (!(await grantVerifiedRole(member))) {
        return interaction.followUp({
          content: ROLE_ERROR_MESSAGE,
          flags: MessageFlags.Ephemeral,
        });
      }

      await sendDMNotification(targetUser, true);
      await sendLogEmbed(client, targetUser, true, null, [], interaction.user);
      recordStatEvent('manual_approved');
      resetFailures(userId);

      pendingManualReviews.delete(interaction.message.id);
      // Se o mesmo usuário tiver outras solicitações abertas, encerra todas
      await closePendingReviewsForUser(client, userId, {
        color: 0x2ecc71,
        footerText: `✅ Aprovado por ${interaction.user.tag}`,
      });

      const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor(0x2ecc71)
        .setFooter({ text: `✅ Aprovado por ${interaction.user.tag}` });

      return interaction.editReply({ embeds: [updatedEmbed], components: [] });
    }

    if (action === 'staff_reject') {
      // Abre um modal pra staff informar o motivo (opcional) antes de recusar
      const modal = new ModalBuilder()
        .setCustomId(`staff_reject_modal:${userId}`)
        .setTitle('Motivo da recusa');

      const motivoInput = new TextInputBuilder()
        .setCustomId('motivo')
        .setLabel('Motivo (opcional)')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Ex: print ilegível, não corresponde ao canal, etc.')
        .setRequired(false);

      modal.addComponents(new ActionRowBuilder().addComponents(motivoInput));

      return interaction.showModal(modal);
    }
  }

  // -----------------------------------------------------------------
  // Modal de motivo, enviado após clicar em "Recusar"
  // -----------------------------------------------------------------
  if (interaction.isModalSubmit()) {
    const [action, userId] = interaction.customId.split(':');
    if (action !== 'staff_reject_modal') return;

    if (!isStaffMember(interaction.member)) {
      return interaction.reply({
        content: '❌ Você não tem permissão para fazer isso.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const motivo = interaction.fields.getTextInputValue('motivo') || 'Recusado manualmente pela staff.';
    const targetUser = await client.users.fetch(userId).catch(() => null);

    if (targetUser) {
      await sendDMNotification(targetUser, false, motivo);
      await sendLogEmbed(client, targetUser, false, null, [motivo], interaction.user);
    }

    recordStatEvent('manual_rejected');

    pendingManualReviews.delete(interaction.message.id);
    // Se o mesmo usuário tiver outras solicitações abertas, encerra todas
    await closePendingReviewsForUser(client, userId, {
      color: 0xe74c3c,
      footerText: `❌ Recusado por ${interaction.user.tag}`,
    });

    const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
      .setColor(0xe74c3c)
      .setFooter({ text: `❌ Recusado por ${interaction.user.tag}` });

    return interaction.update({ embeds: [updatedEmbed], components: [] });
  }
}

// Wrapper: qualquer erro inesperado é logado e o usuário recebe um aviso,
// em vez de ver "O aplicativo não respondeu".
client.on('interactionCreate', async (interaction) => {
  try {
    await handleInteraction(interaction);
  } catch (err) {
    console.error('[INTERACTION ERRO]', err);

    try {
      const payload = {
        content: '❌ Ocorreu um erro inesperado ao processar essa ação. Tente novamente.',
        flags: MessageFlags.Ephemeral,
      };
      if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
      else await interaction.reply(payload);
    } catch {
      // Interação já expirada: nada mais a fazer
    }
  }
});

// ---------------------------------------------------------------------
// Handler de Mensagens (Verificação Automática)
// ---------------------------------------------------------------------
// Pontuação de um resultado de OCR (quantos critérios foram encontrados),
// usada para guardar o "melhor" print quando o usuário envia vários.
const ocrScore = (r) => Number(r.foundChannelName) + Number(r.foundSubscribedWord);

// ---------------------------------------------------------------------
// Honeypot: qualquer mensagem no canal restrito resulta em banimento.
// deleteMessageSeconds apaga o histórico recente do usuário em TODOS os
// canais (útil contra contas comprometidas que saem spammando).
// Requer a permissão "Banir Membros" e cargo do bot acima do usuário.
// ---------------------------------------------------------------------
async function handleHoneypotViolation(message) {
  const { author, guild } = message;
  console.log(`[SEGURANÇA] Violação detectada do usuário ${author.tag} (${author.id})`);

  try {
    await guild.members.ban(author.id, {
      deleteMessageSeconds: HONEYPOT_DELETE_SECONDS,
      reason: 'Segurança: envio de mensagem em canal proibido/restrito (honeypot)',
    });
    console.log(`[SEGURANÇA] Usuário ${author.tag} banido com sucesso.`);
    await sendHoneypotLog(client, message, { banned: true });
  } catch (err) {
    console.error('[SEGURANÇA ERRO] Não foi possível banir o usuário:', err.message);
    // Se o ban falhou, ao menos remove a mensagem do canal
    await message.delete().catch(() => {});
    await sendHoneypotLog(client, message, { banned: false, errorMessage: err.message });
  }
}

// ---------------------------------------------------------------------
// Handler de Mensagens
// ---------------------------------------------------------------------
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (!markProcessedOnce(processedMessageIds, message.id)) return;

    // -----------------------------------------------------------------
    // Sistema de Segurança / Canal Restrito (Honeypot)
    // -----------------------------------------------------------------
    if (HONEYPOT_CHANNEL_ID && message.channel.id === HONEYPOT_CHANNEL_ID) {
      await handleHoneypotViolation(message);
      return;
    }

    // -----------------------------------------------------------------
    // Canal de Verificação
    // -----------------------------------------------------------------
    if (message.channel.id !== VERIFICATION_CHANNEL_ID) return;

    // Quem já é verificado não precisa gastar tentativa nem chamada de OCR
    const member = await fetchMember(message.guild, message.author.id);
    if (hasVerifiedRole(member)) {
      await replyAndCleanup(message, '✅ Você já está verificado! Não precisa enviar outro print.');
      return;
    }

    const startTime = Date.now();

    const validAttachments = [...message.attachments.values()].filter((att) =>
      (att.contentType || '').startsWith('image/')
    );

    if (validAttachments.length === 0) {
      await replyAndCleanup(
        message,
        '📎 Envie um **print de tela** mostrando o canal **Shai WZL** e o botão **"Inscrito"** para eu poder verificar.'
      );
      return;
    }

    const imageAttachments = validAttachments.filter((att) => att.size <= MAX_FILE_SIZE_BYTES);

    if (imageAttachments.length === 0) {
      await replyAndCleanup(
        message,
        `⚠️ A imagem enviada é muito grande! Envie um print com tamanho menor que **${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB**.`
      );
      return;
    }

    if (isRateLimited(message.author.id)) {
      const resetSeconds = getRateLimitResetSeconds(message.author.id);
      await replyAndCleanup(
        message,
        `🕒 Você atingiu o limite de **${RATE_LIMIT_MAX_ATTEMPTS} tentativas** em um curto período. Tente novamente em **${resetSeconds}s**.`
      );
      return;
    }
    registerAttempt(message.author.id);

    // Guarda a reação retornada por react(): é mais confiável do que procurá-la
    // depois no cache de reações (que este bot mantém desabilitado).
    const hourglass = await message.react('⏳').catch(() => null);

    let melhorResultado = null;

    for (const attachment of imageAttachments) {
      let text = '';
      try {
        text = await extractTextFromAttachment(attachment.url);
      } catch (err) {
        console.error(`[OCR ERRO] ${attachment.id}:`, err.message);
        continue;
      }

      const resultado = evaluateOcrText(text);
      if (resultado.passed) {
        melhorResultado = resultado;
        break;
      }
      if (!melhorResultado || ocrScore(resultado) > ocrScore(melhorResultado)) {
        melhorResultado = resultado;
      }
    }

    await hourglass?.users.remove(client.user.id).catch(() => {});

    const durationSeconds = ((Date.now() - startTime) / 1000).toFixed(2);

    // CASO DE ERRO DE LEITURA DA API / TIMEOUT
    if (!melhorResultado) {
      await message.react('⚠️').catch(() => {});

      const printUrl = imageAttachments[0].url;
      recordStatEvent('ocr_error');

      // 1. Envia notificação para o canal da Staff (com botões de aprovar/recusar)
      const staffMessage = await notifyStaffForManualReview(client, message.author, printUrl);

      // Se a staff não pôde ser acionada (canal inválido, sem permissão...), não
      // prometer uma análise manual que nunca vai acontecer.
      if (!staffMessage) {
        const botReply = await message.reply(
          '⚠️ Ocorreu um erro ao ler a sua imagem e não consegui acionar a **STAFF** automaticamente. Tente enviar o print novamente em alguns minutos ou abra um ticket.'
        );
        scheduleMessageCleanup(message, botReply, WARNING_CLEANUP_DELAY_MS);
        return;
      }

      // 2. Avisa no canal de verificação
      const botReply = await message.reply(
        `⚠️ Ocorreu um erro ao tentar ler a sua imagem. Sua verificação foi encaminhada para a **STAFF** e, por demandar da equipe de suporte, a análise manual pode levar **algumas horas**.`
      );

      // 3. Avisa na DM do usuário
      try {
        const dmEmbed = new EmbedBuilder()
          .setColor(0xf1c40f)
          .setTitle('⚠️ Verificação Encaminhada para a Staff')
          .setDescription(
            'Houve um erro no processamento automático da sua imagem. Encaminhamos o seu print para a **STAFF** realizar a verificação manualmente. Por demandar da equipe de suporte, esse processo pode levar **algumas horas**.'
          )
          .setTimestamp();

        await message.author.send({ embeds: [dmEmbed] }).catch(() => {});
      } catch (err) {}

      scheduleMessageCleanup(message, botReply);
      return;
    }

    if (melhorResultado.passed) {
      await message.react('✅').catch(() => {});

      const memberToVerify = member ?? (await fetchMember(message.guild, message.author.id));
      if (memberToVerify) {
        await grantVerifiedRole(memberToVerify);
      }

      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setDescription('Inscrição verificada com sucesso!');

      const botReply = await message.reply({ content: `${message.author}`, embeds: [embed] });
      scheduleMessageCleanup(message, botReply);

      await sendDMNotification(message.author, true);
      await sendLogEmbed(client, message.author, true, durationSeconds);
      recordStatEvent('auto_approved');
      resetFailures(message.author.id);
    } else {
      await message.react('❌').catch(() => {});

      const motivos = [];
      if (!melhorResultado.foundChannelName) motivos.push('Não encontrou o nome do canal (Shai WZL)');
      if (!melhorResultado.foundSubscribedWord) {
        motivos.push(
          melhorResultado.foundNegative
            ? 'O print mostra o botão "Inscrever-se" — parece que você ainda não está inscrito'
            : 'Não encontrou a confirmação de inscrito'
        );
      }

      const motivosTexto = motivos.join(' e ');

      const embed = new EmbedBuilder()
        .setColor(0xe74c3c)
        .setDescription(
          `❌ Não consegui confirmar sua inscrição.\n` +
          `Motivo: ${motivosTexto}.\n\n` +
          `Envie um print nítido mostrando o **nome do canal** e o **botão "Inscrito"** (com o sininho), sem cortar essa parte da tela.`
        );

      const botReply = await message.reply({ embeds: [embed] });
      scheduleMessageCleanup(message, botReply);

      await sendDMNotification(message.author, false, motivosTexto);
      await sendLogEmbed(client, message.author, false, durationSeconds, motivos);
      recordStatEvent('auto_rejected');

      const failureCount = registerFailure(message.author.id);
      if (failureCount >= MAX_CONSECUTIVE_FAILURES) {
        resetFailures(message.author.id); // evita repetir o aviso a cada falha subsequente

        const avisoEmbed = new EmbedBuilder()
          .setColor(0xf1c40f)
          .setDescription(
            `${message.author}, você já teve **${failureCount} tentativas seguidas** sem sucesso.\n` +
              `Se estiver com dificuldade, recomendamos abrir um ticket com a **staff** para receber ajuda direta.`
          );

        const avisoMsg = await message.channel.send({ embeds: [avisoEmbed] });
        setTimeout(() => avisoMsg.delete().catch(() => {}), RESULT_CLEANUP_DELAY_MS * 2);
      }
    }
  } catch (err) {
    console.error('[ERRO GLOBAL]', err);
    await message.react('⚠️').catch(() => {});
  }
});

client.login(DISCORD_TOKEN);