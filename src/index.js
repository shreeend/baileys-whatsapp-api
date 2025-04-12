const { createServer } = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');


// Create Express app
const app = express();
const port = process.env.PORT || 3000;
const httpServer = createServer(app);

// Set up Socket.IO
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function(req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function(req, file, cb) {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({ storage });

// Store active WhatsApp connections
const clients = {};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Initialize WhatsApp client for a device
async function startWhatsAppClient(deviceId, socket) {
  // Create sessions directory
  const sessionsDir = path.join(__dirname, '..', 'sessions', deviceId);
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
  }

  // Use a different auth file for each device
  const { state, saveCreds } = await useMultiFileAuthState(sessionsDir);

  // Set up Baileys client options
  const client = makeWASocket({
    printQRInTerminal: false,
    auth: state,
    logger: pino({ level: 'warn' }),
  });

  // Save reference to client
  clients[deviceId] = {
    client,
    socket,
    saveCreds,
    qrGenerated: false
  };

  // Handle connection events
  client.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    // Send QR code to frontend
    if (qr && !clients[deviceId].qrGenerated) {
      clients[deviceId].qrGenerated = true;
      socket.emit('qr', qr);
      socket.emit('status', 'qr');
    }
    
    // Handle connection state changes
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom &&
        lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut);
      
      socket.emit('status', 'disconnected');
      
      if (shouldReconnect) {
        // Reconnect if not logged out
        startWhatsAppClient(deviceId, socket);
      } else {
        // Remove client if logged out
        socket.emit('unauthorized');
        delete clients[deviceId];
      }
    } else if (connection === 'open') {
      socket.emit('status', 'ready');
      const phoneNumber = client.user?.id?.split(':')[0];
      socket.emit('ready', { phoneNumber });
    }
  });

  // Handle credential updates
  client.ev.on('creds.update', saveCreds);
  
  return client;
}

// Create connection when socket client connects
io.on('connection', (socket) => {
  console.log('Client connected');
  let deviceId = socket.handshake.query.deviceId;
  
  if (!deviceId) {
    socket.disconnect();
    return;
  }
  
  socket.on('initialize', async (data) => {
    if (data.deviceId) {
      deviceId = data.deviceId;
    }
    
    if (clients[deviceId]) {
      // Client already exists, check if it's connected
      if (clients[deviceId].client.user) {
        // Already authenticated, send ready event
        socket.emit('status', 'ready');
        const phoneNumber = clients[deviceId].client.user.id.split(':')[0];
        socket.emit('ready', { phoneNumber });
      } else {
        // Not authenticated, start new session
        clients[deviceId].socket = socket;
        clients[deviceId].qrGenerated = false;
        startWhatsAppClient(deviceId, socket);
      }
    } else {
      // New client
      await startWhatsAppClient(deviceId, socket);
    }
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected');
    // Don't destroy the WhatsApp client on socket disconnect
    // as the user might reconnect later
  });
});

// Send text message
app.post('/send-message', async (req, res) => {
  try {
    const { deviceId, number, message } = req.body;
    
    if (!deviceId || !number || !message) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    if (!clients[deviceId] || !clients[deviceId].client.user) {
      return res.status(404).json({ error: 'Device not connected' });
    }
    
    // Ensure number is in the correct format (with country code)
    let formattedNumber = number.includes('@') ? number : `${number}@s.whatsapp.net`;
    
    await clients[deviceId].client.sendMessage(formattedNumber, { text: message });
    
    res.json({ success: true, message: 'Message sent successfully' });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send media (image, document, etc.)
app.post('/send-media', upload.single('file'), async (req, res) => {
  try {
    const { deviceId, number, caption, type } = req.body;
    const file = req.file;
    
    if (!deviceId || !number || !file) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    if (!clients[deviceId] || !clients[deviceId].client.user) {
      return res.status(404).json({ error: 'Device not connected' });
    }
    
    // Ensure number is in the correct format
    let formattedNumber = number.includes('@') ? number : `${number}@s.whatsapp.net`;
    
    // Determine media type from request or file mimetype
    const mediaType = type || (file.mimetype.startsWith('image/') ? 'image' : 
                             file.mimetype.startsWith('video/') ? 'video' : 'document');
    
    // Create the appropriate media object
    const mediaMessage = {};
    
    if (mediaType === 'image') {
      mediaMessage.image = { url: file.path };
      if (caption) mediaMessage.caption = caption;
    } else if (mediaType === 'video') {
      mediaMessage.video = { url: file.path };
      if (caption) mediaMessage.caption = caption;
    } else {
      // Default to document
      mediaMessage.document = { 
        url: file.path,
        filename: file.originalname
      };
      if (caption) mediaMessage.caption = caption;
    }
    
    await clients[deviceId].client.sendMessage(formattedNumber, mediaMessage);
    
    // Delete the file after sending
    fs.unlinkSync(file.path);
    
    res.json({ success: true, message: 'Media sent successfully' });
  } catch (error) {
    console.error('Error sending media:', error);
    
    // Delete the file if there was an error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({ error: error.message });
  }
});

// Logout/disconnect a device
app.post('/logout', async (req, res) => {
  try {
    const { deviceId } = req.body;
    
    if (!deviceId) {
      return res.status(400).json({ error: 'Device ID is required' });
    }
    
    if (clients[deviceId]) {
      // Logout and delete session
      await clients[deviceId].client.logout();
      delete clients[deviceId];
      
      // Optional: Delete session files
      const sessionsDir = path.join(__dirname, '..', 'sessions', deviceId);
      if (fs.existsSync(sessionsDir)) {
        fs.rmSync(sessionsDir, { recursive: true, force: true });
      }
      
      res.json({ success: true, message: 'Logged out successfully' });
    } else {
      res.status(404).json({ error: 'Device not found' });
    }
  } catch (error) {
    console.error('Error logging out:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start the server
httpServer.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
