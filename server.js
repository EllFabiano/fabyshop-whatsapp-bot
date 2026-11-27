const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = process.env.PORT || 3001;
const AUTH_DIR = path.join(__dirname, 'auth_info');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Estado da Conexão
let sock = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'
let connectedPhone = '';
let currentQrDataUrl = null;
let currentQrRaw = '';
let reconnectAttempts = 0;

// Normaliza qualquer número para dígitos com DDI (Angola 244, Moçambique 258, Brasil 55, Portugal 351, EUA 1...)
function normalizePhoneDigits(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (!digits) return null;

  // Já vem com DDI completo (o comprimento total confirma o país)
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) return digits; // Brasil
  if (digits.startsWith('244') && digits.length === 12) return digits; // Angola
  if (digits.startsWith('258') && digits.length === 12) return digits; // Moçambique
  if (digits.startsWith('351') && digits.length === 12) return digits; // Portugal

  // Brasil sem DDI: DDD (2) + 8 ou 9 dígitos. Inclui DDD 55 (RS) e DDDs 1x (11 = São Paulo).
  if (digits.length === 10 || digits.length === 11) {
    // EUA: 1 + 10 dígitos (o 3º dígito de um celular brasileiro de 11 dígitos é sempre 9)
    if (digits.length === 11 && digits.startsWith('1') && digits[2] !== '9') return digits;
    return '55' + digits;
  }

  // Angola (9 dígitos começando com 9) / Moçambique (9 dígitos começando com 8)
  if (digits.length === 9 && digits.startsWith('9')) return '244' + digits;
  if (digits.length === 9 && digits.startsWith('8')) return '258' + digits;

  return digits;
}

// Formatador de número para o formato WhatsApp JID (ex: 5511999308909@s.whatsapp.net)
function formatPhoneToJid(phone) {
  const digits = normalizePhoneDigits(phone);
  return digits ? `${digits}@s.whatsapp.net` : null;
}

// Resolve o JID REAL no WhatsApp. Necessário para o Brasil: contas antigas fora de SP/RJ/ES etc.
// estão registadas SEM o 9º dígito, e enviar para o JID errado "funciona" mas a mensagem nunca chega.
async function resolveJid(phone) {
  const digits = normalizePhoneDigits(phone);
  if (!digits) return { jid: null, error: 'Número de WhatsApp inválido.' };

  const candidates = [digits];
  if (digits.startsWith('55') && digits.length >= 12) {
    const ddd = digits.slice(2, 4);
    const num = digits.slice(4);
    if (num.length === 9 && num[0] === '9') candidates.push('55' + ddd + num.slice(1)); // sem o 9
    else if (num.length === 8) candidates.unshift('55' + ddd + '9' + num);              // com o 9
  }

  try {
    const results = await sock.onWhatsApp(...candidates.map(c => c + '@s.whatsapp.net'));
    const found = (results || []).find(r => r && r.exists);
    if (found && found.jid) return { jid: found.jid, digits };
    return { jid: null, digits, notFound: true, error: `O número +${digits} não tem WhatsApp (ou está incorreto).` };
  } catch (e) {
    console.warn('[WhatsApp Bot] Falha ao verificar número, usando JID padrão:', e.message);
    return { jid: `${digits}@s.whatsapp.net`, digits };
  }
}

// Construtor de mensagens para clientes
function buildClientMessage(type, data) {
  data = data || {};
  const nome = data.userName || data.customerName || data.name || 'Cliente';
  const siteUrl = 'https://www.fabyshop.shop/perfil.html';

  switch (type) {
    case 'order_ff': {
      const pacote = (data.package || data.packageName || 'Diamantes Free Fire').replace(/\s*[Dd]iamantes/gi, '').trim() + ' Diamantes';
      const gameId = data.gameId || 'N/A';
      const gameNick = data.gameNick || 'N/A';
      const preco = data.price ? String(data.price).replace(/Kz/gi, '').trim() + ' Kz' : 'N/A';
      
      return `Olá, *${nome}*! 🎉\n\n` +
        `A sua recarga na *FABY SHOP* foi concluída com sucesso! 💎✨\n\n` +
        `📋 *Detalhes da Entrega:*\n` +
        `🎮 *ID Free Fire:* ${gameId}\n` +
        `👤 *Nick:* ${gameNick}\n` +
        `📦 *Pacote:* ${pacote}\n` +
        `💰 *Valor:* ${preco}\n` +
        `✅ *Status:* Concluído & Entregue no Jogo\n\n` +
        `Os seus diamantes já estão na sua conta! Acesse o histórico em:\n` +
        `👉 ${siteUrl}\n\n` +
        `Muito obrigado pela confiança e preferência! Bom jogo! 🔥`;
    }

    case 'giftcard': {
      const produto = data.productName || data.service || 'Gift Card';
      const pin = data.pin || data.code || 'Código disponível no site';
      const plano = data.plan ? ` (${data.plan})` : '';

      return `Olá, *${nome}*! 🎁\n\n` +
        `O seu pedido de *${produto}${plano}* na *FABY SHOP* foi concluído e emitido com sucesso! 🛍️\n\n` +
        `🔑 *Código / PIN de Ativação:*\n` +
        `\`${pin}\`\n\n` +
        `ℹ️ *Instruções:* Copie o código acima e resgate diretamente na sua conta da plataforma oficial.\n` +
        `Você também pode consultar o seu código no seu perfil da loja:\n` +
        `👉 ${siteUrl}\n\n` +
        `Agradecemos a sua preferência na FABY SHOP! Volte sempre! ✨`;
    }

    case 'streaming': {
      const produto = data.productName || data.service || 'Assinatura Streaming';
      const email = data.accountEmail || data.netflixEmail || data.email || data.login || 'N/A';
      const senha = data.accountPassword || data.netflixPassword || data.password || data.senha || 'N/A';
      const perfil = data.profileName || data.netflixProfile || data.profile || 'Perfil Privado';
      const pin = data.profilePin || data.netflixPin || data.pin || '';
      const validade = data.expireDateStr || '30 Dias';
      const notas = data.adminNotes || data.notes || '';

      return `Olá, *${nome}*! 🎬🍿\n\n` +
        `A sua assinatura de *${produto}* na *FABY SHOP* já está ativa e pronta para você assistir! 🎉\n\n` +
        `📋 *Dados de Acesso:*\n` +
        `📧 *E-mail / Login:* \`${email}\`\n` +
        `🔑 *Senha:* \`${senha}\`\n` +
        `👤 *Seu Perfil:* ${perfil}${pin ? ` (PIN: ${pin})` : ''}\n` +
        `📅 *Validade:* ${validade}\n` +
        (notas ? `📝 *Observações:* ${notas}\n` : '') +
        `\n⚠️ *Avisos Importantes:*\n` +
        `• Utilize apenas o seu perfil designado.\n` +
        `• Não altere o email ou senha da conta compartilhada.\n` +
        `• Caso a Netflix solicite código de login ao entrar, acesse o seu perfil no site e clique em *"Pedir Novo Código"* que o administrador fornecerá rapidamente!\n\n` +
        `Acesse o seu histórico na FABY SHOP: 👉 ${siteUrl}\n\n` +
        `Tenha um ótimo entretenimento! 📺✨`;
    }

    case 'netflix_code': {
      const codigo = data.code || data.loginCode || '0000';
      const perfil = data.profileName || data.profile || 'Perfil Privado';
      return `Olá, *${nome}*! 🎬🍿\n\n` +
        `Aqui está o seu *Código de Acesso da Netflix* solicitado para o perfil *${perfil}*:\n\n` +
        `🔑 *CÓDIGO DE LOGIN:* \`${codigo}\`\n\n` +
        `⏱️ *Validade:* Este código é temporário e expira em *10 minutos*.\n` +
        `Insira-o imediatamente no aplicativo ou site da Netflix para liberar o seu acesso!\n\n` +
        `Acesse seu perfil: 👉 ${siteUrl}\n\n` +
        `Equipe *FABY SHOP* ✨`;
    }

    case 'fc_deposit': {
      const amount = data.requestedFp || data.amount || '0';
      const preco = data.priceKz ? `${data.priceKz} Kz` : '';

      return `Olá, *${nome}*! 💰🎉\n\n` +
        `O seu carregamento de *${amount} Faby Coins (F€)* foi aprovado com sucesso na *FABY SHOP*!\n\n` +
        `💳 O saldo já se encontra creditado na sua carteira da loja.\n` +
        (preco ? `💵 *Valor Pago:* ${preco}\n` : '') +
        `🚀 Você já pode usar seus Faby Coins para comprar recargas instantâneas e Gift Cards no site!\n\n` +
        `Verifique o seu saldo atualizado em:\n` +
        `👉 ${siteUrl}\n\n` +
        `Obrigado por escolher a FABY SHOP! 🔥`;
    }

    case 'order_rejected':
    case 'order_cancelled':
    case 'order_failed': {
      const item = data.package || data.productName || data.service || 'Pedido de Recarga';
      const motivo = data.failReason || data.reason || 'Dados incorretos ou verificação não aprovada';
      const gameId = data.gameId ? `\n🎮 *ID Free Fire:* ${data.gameId}` : '';
      const reembolsado = data.refunded 
        ? `\n💎 *Reembolso Efetuado:* O saldo de Faby Coins (F€) foi totalmente devolvido à sua carteira no site!\n`
        : '';

      return `Olá, *${nome}*! ⚠️\n\n` +
        `Informamos que o seu pedido de *${item}* na *FABY SHOP* foi *CANCELADO / REJEITADO*.\n\n` +
        `❌ *Motivo da Rejeição:*\n` +
        `» *${motivo}*\n` +
        gameId + '\n' +
        reembolsado +
        `\nℹ️ Se precisar de ajuda ou desejar corrigir as informações, acesse o seu perfil ou fale com o suporte:\n` +
        `👉 ${siteUrl}\n\n` +
        `Equipe *FABY SHOP*.`;
    }

    case 'deposit_rejected':
    case 'deposit_cancelled': {
      const amount = data.requestedFp || data.amount || '0';
      const motivo = data.failReason || data.reason || 'Comprovativo ilegível, inválido ou dados divergentes';

      return `Olá, *${nome}*! ⚠️\n\n` +
        `Informamos que o seu carregamento de *${amount} Faby Coins (F€)* na *FABY SHOP* foi *REJEITADO*.\n\n` +
        `❌ *Motivo da Rejeição:*\n` +
        `» *${motivo}*\n\n` +
        `ℹ️ Verifique o comprovativo bancário e solicite novamente no site com a imagem legível e completa:\n` +
        `👉 ${siteUrl}\n\n` +
        `Equipe *FABY SHOP*.`;
    }

    default: {
      return `Olá, *${nome}*!\n\n` +
        `O seu pedido na *FABY SHOP* foi atualizado com sucesso! ✅\n` +
        `Acesse o seu perfil para acompanhar:\n` +
        `👉 ${siteUrl}`;
    }
  }
}

// ─── PERSISTÊNCIA EM NUVEM (UPSTASH REDIS REST API - 100% GRATUITO) ───
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || 'https://warm-sculpin-134503.upstash.io';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAg1nAAIgcDJlZmVkMWJiYzAzM2E0ODg1OTU3MDFiMWQ1MjdhNDM2ZA';

async function restoreSessionFromCloud() {
  if (!REDIS_URL || !REDIS_TOKEN) return false;
  try {
    const res = await fetch(`${REDIS_URL}/get/fabyshop_wa_session`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    const data = await res.json();
    if (data && data.result) {
      let cur = data.result;
      // Desembrulha arrays e strings aninhadas do Redis com segurança
      for (let i = 0; i < 10; i++) {
        if (typeof cur === 'string') {
          // Checa se é payload comprimido com gzip em base64 (começa com H4sI ou similar)
          if (cur.startsWith('H4sI') || (!cur.startsWith('{') && !cur.startsWith('['))) {
            try {
              const buf = Buffer.from(cur, 'base64');
              const unzipped = zlib.gunzipSync(buf).toString('utf8');
              cur = JSON.parse(unzipped);
              break;
            } catch (e) {
              // fallback se não for gzip
            }
          }
          try { cur = JSON.parse(cur); } catch (e) { break; }
        }
        if (Array.isArray(cur)) {
          cur = cur[0];
        } else if (typeof cur === 'object' && cur !== null) {
          if ('creds.json' in cur) break;
          if ('0' in cur && typeof cur['0'] === 'string') cur = cur['0'];
          else break;
        }
      }

      if (cur && typeof cur === 'object' && ('creds.json' in cur || Object.keys(cur).some(k => k.endsWith('.json')))) {
        if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
        let written = 0;
        for (const [filename, content] of Object.entries(cur)) {
          if (typeof filename === 'string' && filename.endsWith('.json') && typeof content === 'string') {
            fs.writeFileSync(path.join(AUTH_DIR, filename), content, 'utf8');
            written++;
          }
        }
        console.log(`[Persistência Cloud] 🟢 Sessão restaurada com sucesso do Redis (${written} arquivos JSON incluindo creds.json)!`);
        return written > 0;
      }
    }
  } catch (err) {
    console.warn('[Persistência Cloud] Falha ao restaurar sessão do Redis:', err.message);
  }
  return false;
}

let _backupTimeout = null;
let _lastCredsHash = '';
let _lastBackupTime = 0;
const BACKUP_MIN_INTERVAL_MS = 30 * 60 * 1000; // No máximo 1 backup a cada 30 min em updates normais

async function backupSessionToCloud(force = false) {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  if (!fs.existsSync(AUTH_DIR)) return;

  const credsFile = path.join(AUTH_DIR, 'creds.json');
  if (!fs.existsSync(credsFile)) return;

  const now = Date.now();
  // Se não for forçado e o último backup foi há menos de 30 minutos, adia
  if (!force && (now - _lastBackupTime < BACKUP_MIN_INTERVAL_MS)) {
    if (!_backupTimeout) {
      const waitTime = BACKUP_MIN_INTERVAL_MS - (now - _lastBackupTime);
      _backupTimeout = setTimeout(() => {
        _backupTimeout = null;
        backupSessionToCloud(false);
      }, waitTime);
    }
    return;
  }

  if (_backupTimeout) {
    clearTimeout(_backupTimeout);
    _backupTimeout = null;
  }

  const delayMs = force ? 1000 : 5000;
  _backupTimeout = setTimeout(async () => {
    _backupTimeout = null;
    try {
      if (!fs.existsSync(credsFile)) return;

      // Monitora o hash exclusivamente do creds.json (evita reenvios inúteis de prekeys temporários)
      const credsContent = fs.readFileSync(credsFile, 'utf8');
      const credsHash = crypto.createHash('md5').update(credsContent).digest('hex');
      if (!force && credsHash === _lastCredsHash) {
        return; // As credenciais principais não mudaram! 0 bytes gastos
      }

      const files = fs.readdirSync(AUTH_DIR).filter(f => f.endsWith('.json'));
      if (!files.length) return;

      const filesMap = {};
      for (const f of files) {
        filesMap[f] = fs.readFileSync(path.join(AUTH_DIR, f), 'utf8');
      }
      const rawPayload = JSON.stringify(filesMap);

      // Comprime com GZIP em Base64 (redução drástica de 92% a 96% no consumo de banda externa)
      const compressedPayload = zlib.gzipSync(Buffer.from(rawPayload, 'utf8')).toString('base64');
      const origSize = Buffer.byteLength(rawPayload);
      const compSize = Buffer.byteLength(compressedPayload);

      const res = await fetch(`${REDIS_URL}/set/fabyshop_wa_session`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${REDIS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify([compressedPayload])
      });

      if (res.ok) {
        _lastCredsHash = credsHash;
        _lastBackupTime = Date.now();
        console.log(`[Persistência Cloud] ☁️ Sessão comprimida e salva no Redis (${files.length} arquivos, ${origSize}B -> ${compSize}B, hash: ${credsHash.slice(0, 8)})!`);
      } else {
        console.warn(`[Persistência Cloud] Aviso ao salvar no Redis (Status ${res.status})`);
      }
    } catch (err) {
      console.warn('[Persistência Cloud] Falha ao salvar sessão no Redis:', err.message);
    }
  }, delayMs);
}

// Inicia a Conexão com o WhatsApp via Baileys
async function startWhatsAppBot() {
  try {
    // Tenta restaurar sessão persistente da nuvem caso a pasta local esteja vazia
    await restoreSessionFromCloud();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307], isLatest: true }));

    console.log(`[WhatsApp Bot] Iniciando Baileys v${version.join('.')} (Última: ${isLatest})...`);

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      browser: ['FABY SHOP Notifier', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      fireInitQueries: false,                // ULTRA-ECONOMIA: não faz download de listas de bloqueio, etiquetas e estados
      generateHighQualityLinkPreview: false, // ULTRA-ECONOMIA: não gera thumbnails pesados para links
      markOnlineOnConnect: false,            // Não força presença online desnecessária
      emitOwnEvents: false,                  // Não reprocessa eventos das próprias mensagens
      keepAliveIntervalMs: 60000,            // Pings a cada 60s (reduz tráfego de keepalive pela metade)
      // Ignora grupos, transmissões e status para economizar banda e CPU:
      shouldIgnoreJid: (jid) => !jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.includes('status'),
      cachedGroupMetadata: () => Promise.resolve(undefined)
    });

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      backupSessionToCloud(false);
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQrRaw = qr;
        connectionStatus = 'connecting';
        try {
          currentQrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 8 });
        } catch (e) {
          console.error('[WhatsApp Bot] Erro ao gerar imagem QR:', e);
        }

        console.log('\n======================================================');
        console.log('📱 ESCANEIE O QR CODE COM O WHATSAPP (+55 11999308909):');
        console.log('======================================================\n');
        qrcodeTerminal.generate(qr, { small: true });
        console.log('\nOu acesse no navegador: http://localhost:' + PORT);
      }

      if (connection === 'close') {
        connectionStatus = 'disconnected';
        currentQrDataUrl = null;
        currentQrRaw = '';
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(`[WhatsApp Bot] ⚠️ Conexão encerrada (Status: ${statusCode}). Reconectar? ${shouldReconnect}`);

        if (shouldReconnect) {
          reconnectAttempts++;
          const delay = Math.min(reconnectAttempts * 3000, 15000);
          console.log(`[WhatsApp Bot] Tentando reconectar em ${delay / 1000}s...`);
          setTimeout(startWhatsAppBot, delay);
        } else {
          console.log('[WhatsApp Bot] ❌ Sessão desconectada pelo usuário. Limpando credenciais antigas...');
          if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          }
          if (REDIS_URL && REDIS_TOKEN) {
            fetch(`${REDIS_URL}/del/fabyshop_wa_session`, {
              headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
            }).catch(() => {});
          }
          reconnectAttempts = 0;
          setTimeout(startWhatsAppBot, 3000);
        }
      } else if (connection === 'open') {
        reconnectAttempts = 0;
        connectionStatus = 'connected';
        currentQrDataUrl = null;
        currentQrRaw = '';
        connectedPhone = (sock.user?.id || '').split(':')[0].split('@')[0];

        console.log('\n======================================================');
        console.log(`[WhatsApp Bot] 🟢 CONECTADO COM SUCESSO!`);
        console.log(`[WhatsApp Bot] 📱 Número Ativo: +${connectedPhone}`);
        console.log(`[WhatsApp Bot] 🚀 Pronto para enviar notificações automáticas!`);
        console.log('======================================================\n');
        backupSessionToCloud(true);
      }
    });

  } catch (err) {
    console.error('[WhatsApp Bot] Erro ao iniciar cliente:', err);
    setTimeout(startWhatsAppBot, 5000);
  }
}

// ─── ENDPOINTS DA API HTTP ───

// Status da Conexão (Ultra-leve: ~60 bytes para não estourar os 5GB do Render)
app.get('/api/status', (req, res) => {
  const wantsQr = req.query.qr === '1' || req.query.qr === 'true';
  res.json({
    status: connectionStatus,
    connected: connectionStatus === 'connected',
    phone: connectedPhone ? `+${connectedPhone}` : null,
    hasQr: Boolean(currentQrRaw),
    // Envia o Base64 pesado (~40KB) apenas quando explicitamente solicitado via ?qr=1
    qr: wantsQr ? currentQrDataUrl : null
  });
});

// Endpoint dedicado para imagem do QR Code (usado na tela de escanear)
app.get('/api/qr', (req, res) => {
  if (connectionStatus === 'connected') {
    return res.json({ connected: true, qr: null });
  }
  return res.json({ connected: false, hasQr: Boolean(currentQrRaw), qr: currentQrDataUrl });
});

// Endpoint leve para Uptime Monitors, Keep-Alive e Health Checks (apenas 2 bytes de resposta)
app.get('/api/ping', (req, res) => res.status(200).send('OK'));
app.get('/health', (req, res) => res.status(200).send('OK'));

// Envio de Mensagem Genérica
app.post('/api/send', async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ error: 'Os campos "phone" e "message" são obrigatórios.' });
  }

  if (connectionStatus !== 'connected' || !sock) {
    return res.status(503).json({ error: 'O WhatsApp Bot não está conectado no momento. Conecte pelo QR Code primeiro.' });
  }

  const resolved = await resolveJid(phone);
  const jid = resolved.jid;
  if (!jid) {
    return res.status(resolved.notFound ? 404 : 400).json({ error: resolved.error || 'Número de WhatsApp inválido.' });
  }

  try {
    const result = await sock.sendMessage(jid, { text: message });
    console.log(`[WhatsApp Bot] ✉️ Mensagem enviada para ${jid}`);
    return res.json({ success: true, jid, messageId: result?.key?.id });
  } catch (error) {
    console.error(`[WhatsApp Bot] ❌ Erro ao enviar mensagem para ${jid}:`, error);
    return res.status(500).json({ error: 'Falha ao enviar mensagem via WhatsApp: ' + error.message });
  }
});

// Envio Formatado de Notificação de Pedido / Depósito
app.post('/api/send-order', async (req, res) => {
  const { type, phone, orderData } = req.body;
  if (!type || !phone) {
    return res.status(400).json({ error: 'Os campos "type" e "phone" são obrigatórios.' });
  }

  if (connectionStatus !== 'connected' || !sock) {
    return res.status(503).json({ error: 'O WhatsApp Bot não está conectado no momento.' });
  }

  const resolved = await resolveJid(phone);
  const jid = resolved.jid;
  if (!jid) {
    return res.status(resolved.notFound ? 404 : 400).json({ error: resolved.error || 'Número de telefone inválido.' });
  }

  const messageText = buildClientMessage(type, orderData);

  try {
    const result = await sock.sendMessage(jid, { text: messageText });
    console.log(`[WhatsApp Bot] 🚀 Notificação [${type}] enviada com sucesso para ${jid}`);
    return res.json({ success: true, jid, messageId: result?.key?.id });
  } catch (error) {
    console.error(`[WhatsApp Bot] ❌ Erro ao enviar notificação de pedido:`, error);
    return res.status(500).json({ error: 'Falha ao disparar mensagem: ' + error.message });
  }
});

// Envio Direto de Notificação para o Administrador (+244940375951)
const DEFAULT_ADMIN_PHONE = process.env.ADMIN_PHONE || '244940375951';

app.post('/api/notify-admin', async (req, res) => {
  const { title, details, message, type, orderData, adminPhone } = req.body || {};
  const targetPhone = adminPhone || DEFAULT_ADMIN_PHONE;

  if (connectionStatus !== 'connected' || !sock) {
    return res.status(503).json({ error: 'O WhatsApp Bot não está conectado no momento.' });
  }

  const resolved = await resolveJid(targetPhone);
  const jid = resolved.jid;
  if (!jid) {
    return res.status(resolved.notFound ? 404 : 400).json({ error: resolved.error || 'Número do administrador inválido.' });
  }

  let textToSend = message || '';

  if (!textToSend && type && orderData) {
    const cust = orderData.userName || orderData.customerName || orderData.name || orderData.userEmail || 'Cliente';
    const clientPhone = orderData.whatsapp || orderData.clientPhone || orderData.userPhone || 'Não informado';

    if (type === 'order' || type === 'order_ff') {
      const pkg = orderData.package || orderData.packageName || 'Recarga Free Fire';
      const price = orderData.price || 'N/A';
      const gid = orderData.gameId || 'N/A';
      const gnick = orderData.gameNick ? ` (${orderData.gameNick})` : '';
      const method = orderData.method ? `\n💳 *Método:* ${orderData.method}` : '';

      textToSend = `🛒 *NOVO PEDIDO NA FABY SHOP!* 💎\n\n` +
        `👤 *Cliente:* ${cust}\n` +
        `🎮 *ID Free Fire:* ${gid}${gnick}\n` +
        `📦 *Pacote:* ${pkg}\n` +
        `💰 *Valor:* ${price}${method}\n` +
        `📱 *WhatsApp Cliente:* ${clientPhone}\n\n` +
        `👉 *Acesse o Painel para Aprovar:*\n` +
        `https://www.fabyshop.shop/admin-fb8x2.html?tab=orders`;

    } else if (type === 'deposit' || type === 'fc_deposit') {
      const amount = orderData.requestedFp || orderData.amount || '0';
      const priceKz = orderData.priceKz ? ` (${orderData.priceKz} Kz)` : '';
      const bank = orderData.bank ? `\n🏦 *Banco/Forma:* ${orderData.bank}` : '';

      textToSend = `💰 *NOVO DEPÓSITO DE F€ SOLICITADO!* 🏦\n\n` +
        `👤 *Cliente:* ${cust}\n` +
        `💵 *Valor Solicitado:* ${amount} FC${priceKz}${bank}\n` +
        `📱 *WhatsApp Cliente:* ${clientPhone}\n\n` +
        `👉 *Conferir Comprovativo no Painel:*\n` +
        `https://www.fabyshop.shop/admin-fb8x2.html?tab=fc`;

    } else if (type === 'streaming' || type === 'giftcard' || type === 'loja_order') {
      const prod = orderData.productName || orderData.service || 'Produto';
      const price = orderData.price || orderData.fcPrice || 'N/A';

      textToSend = `🛍️ *NOVO PEDIDO NA LOJA!* 🎬\n\n` +
        `👤 *Cliente:* ${cust}\n` +
        `📦 *Item:* ${prod}\n` +
        `💎 *Preço:* ${price}\n` +
        `📱 *WhatsApp Cliente:* ${clientPhone}\n\n` +
        `👉 *Acesse para Entregar:*\n` +
        `https://www.fabyshop.shop/admin-fb8x2.html?tab=subscriptions`;

    } else if (type === 'chat') {
      const msgTxt = (orderData.text || orderData.message || 'Nova mensagem').substring(0, 150);
      textToSend = `💬 *NOVA MENSAGEM DE SUPORTE NO SITE!* 🎧\n\n` +
        `👤 *De:* ${cust}\n` +
        `📝 "${msgTxt}"\n\n` +
        `👉 *Responder no Painel:*\n` +
        `https://www.fabyshop.shop/admin-fb8x2.html`;
    }
  }

  if (!textToSend && (title || details)) {
    textToSend = `🔔 *${title || 'ALERTA FABY SHOP'}*\n\n${details || ''}\n\nhttps://www.fabyshop.shop/admin-fb8x2.html`;
  }

  if (!textToSend) {
    return res.status(400).json({ error: 'Nenhum conteúdo fornecido para a notificação.' });
  }

  try {
    const result = await sock.sendMessage(jid, { text: textToSend });
    console.log(`[WhatsApp Bot] 👑 Notificação de Administrador enviada com sucesso para ${jid}`);
    return res.json({ success: true, jid, messageId: result?.key?.id });
  } catch (error) {
    console.error(`[WhatsApp Bot] ❌ Erro ao notificar administrador:`, error);
    return res.status(500).json({ error: 'Falha ao enviar para o administrador: ' + error.message });
  }
});

// Desconectar / Trocar de Número
app.post('/api/disconnect', async (req, res) => {
  try {
    if (sock) {
      await sock.logout().catch(() => {});
    }
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    if (REDIS_URL && REDIS_TOKEN) {
      fetch(`${REDIS_URL}/del/fabyshop_wa_session`, {
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
      }).catch(() => {});
    }
    connectionStatus = 'disconnected';
    connectedPhone = '';
    currentQrDataUrl = null;
    currentQrRaw = '';
    console.log('[WhatsApp Bot] Sessão desconectada e credenciais removidas.');
    setTimeout(startWhatsAppBot, 1500);
    return res.json({ success: true, message: 'Desconectado com sucesso. Novo QR Code será gerado.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Inicia o Servidor HTTP
app.listen(PORT, '0.0.0.0', () => {
  console.log(`======================================================`);
  console.log(`🤖 FABY SHOP - WHATSAPP BOT API`);
  console.log(`🌐 Painel Visual: http://127.0.0.1:${PORT}`);
  console.log(`📡 Porta: ${PORT}`);
  console.log(`======================================================`);
  startWhatsAppBot();

  // Auto-Ping para manter o servidor acordado 24h caso hospedado no Render / Nuvem (usa /api/ping de apenas 2 bytes)
  const externalUrl = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;
  if (externalUrl) {
    console.log(`[Keep-Alive] Configurado auto-ping a cada 10 min para: ${externalUrl}/api/ping`);
    setInterval(() => {
      fetch(`${externalUrl}/api/ping`)
        .then(() => console.log(`[Keep-Alive] ⏰ Auto-ping executado (${new Date().toLocaleTimeString()})`))
        .catch(err => console.warn('[Keep-Alive] Falha no auto-ping:', err.message));
    }, 10 * 60 * 1000);
  }

  // Abre o navegador automaticamente apenas em ambiente local Windows
  setTimeout(() => {
    try {
      const { exec } = require('child_process');
      if (process.platform === 'win32' && !process.env.RENDER) {
        exec(`start http://127.0.0.1:${PORT}`);
      }
    } catch (e) {}
  }, 800);
});

