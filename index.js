const express = require('express');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const User = require('./models/User');
const Message = require('./models/Message');
const ws = require('ws');
const fs = require('fs');

dotenv.config();
mongoose.set('strictQuery', false);
mongoose.connect(process.env.MONGO_URL, (err) => {
  if (err) throw err;
});

const jwtSecret = process.env.JWT_SECRET;
const bcryptSalt = bcrypt.genSaltSync(10);

const app = express();
app.use('/uploads', express.static(__dirname + '/uploads'));
app.use(express.json());
app.use(cookieParser());
app.use(cors({
  credentials: true,
  origin: 'https://neww-mesgar10.onrender.com'
}));

async function getUserDataFromRequest(req) {
  return new Promise((resolve, reject) => {
    const token = req.cookies?.token;
    if (token) {
      jwt.verify(token, jwtSecret, {}, (err, userData) => {
        if (err) throw err;
        resolve(userData);
      });
    } else {
      reject('no token');
    }
  });
}

app.get('/test', (req,res) => {
  res.json('test ok');
});

app.get('/peoples', async (req,res) => {
  const users = await User.find({}, {'_id':1,username:1});
  res.json(users);
});

app.get('/search', async (req, res) => {
  try {
    const { query } = req.query;
    const users = await User.find({
      username: { $regex: new RegExp(query, 'i') },
    });
    res.json(users);
  } catch (error) {
    console.error(error);
    res.status(500).json('error');
  }
});

app.get('/people', async (req, res) => {
  try {
    const userData = await getUserDataFromRequest(req);
    const ourUserId = userData.userId;

    const usersWithSentText = await Message.distinct('recipient', {
      sender: ourUserId,
      text: { $ne: '' },
    });

    const usersWithReceivedText = await Message.distinct('sender', {
      recipient: ourUserId,
      text: { $ne: '' },
    });

    const users = await User.find(
      {
        _id: {
          $in: [...usersWithSentText, ...usersWithReceivedText, ourUserId],
          $ne: ourUserId,
        },
      },
      { _id: 1, username: 1 }
    );

    res.json(users);
  } catch (error) {
    console.error(error);
    res.status(500).json('error');
  }
});

app.get('/messages/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const userData = await getUserDataFromRequest(req);
    const ourUserId = userData.userId;

    const messages = await Message.find({
      $or: [
        { sender: ourUserId, recipient: userId },
        { sender: userId, recipient: ourUserId },
      ],
    }).sort({ createdAt: 1 });

    const messagesWithReplyInfo = messages.map((message) => {
      return {
        ...message.toJSON(),
        replyTo: null,
      };
    });

    res.json(messagesWithReplyInfo);
  } catch (error) {
    console.error(error);
    res.status(500).json('error');
  }
});

app.get('/profile', (req,res) => {
  const token = req.cookies?.token;
  if (token) {
    jwt.verify(token, jwtSecret, {}, (err, userData) => {
      if (err) throw err;
      res.json(userData);
    });
  } else {
    res.status(401).json('no token');
  }
});

app.post('/login', async (req,res) => {
  const {username, password} = req.body;
  const foundUser = await User.findOne({username});
  if (foundUser) {
    const passOk = bcrypt.compareSync(password, foundUser.password);
    if (passOk) {
      jwt.sign({userId:foundUser._id,username}, jwtSecret, {}, (err, token) => {
        res.cookie('token', token, {sameSite:'none', secure:true}).json({
          id: foundUser._id,
        });
      });
    }
  }
});

app.post('/logout', (req,res) => {
  res.cookie('token', '', {sameSite:'none', secure:true}).json('ok');
});

app.post('/register', async (req,res) => {
  const {username,password} = req.body;
  try {
    const hashedPassword = bcrypt.hashSync(password, bcryptSalt);
    const createdUser = await User.create({
      username:username,
      password:hashedPassword,
    });
    jwt.sign({userId:createdUser._id,username}, jwtSecret, {}, (err, token) => {
      if (err) throw err;
      res.cookie('token', token, {sameSite:'none', secure:true}).status(201).json({
        id: createdUser._id,
      });
    });
  } catch(err) {
    if (err) throw err;
    res.status(500).json('error');
  }
});

// New endpoint to fetch unread message count for a user
app.get('/unread-messages/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ unreadMessages: user.unreadMessages });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


const server = app.listen(4040);

const wss = new ws.WebSocketServer({server});
wss.on('connection', (connection, req) => {
  function notifyAboutOnlinePeople() {
    [...wss.clients].forEach(client => {
      client.send(JSON.stringify({
        online: [...wss.clients].map(c => ({userId:c.userId,username:c.username})),
      }));
    });
  }

  connection.isAlive = true;

  connection.timer = setInterval(() => {
    connection.ping();
    connection.deathTimer = setTimeout(() => {
      connection.isAlive = false;
      clearInterval(connection.timer);
      connection.terminate();
      notifyAboutOnlinePeople();
      console.log('dead');
    }, 1000);
  }, 5000);

  connection.on('pong', () => {
    clearTimeout(connection.deathTimer);
  });

  const cookies = req.headers.cookie;
  if (cookies) {
    const tokenCookieString = cookies.split(';').find(str => str.startsWith('token='));
    if (tokenCookieString) {
      const token = tokenCookieString.split('=')[1];
      if (token) {
        jwt.verify(token, jwtSecret, {}, (err, userData) => {
          if (err) throw err;
          const {userId, username} = userData;
          connection.userId = userId;
          connection.username = username;
        });
      }
    }
  }

  connection.on('message', async (message) => {
    const messageData = JSON.parse(message.toString());
    const {recipient, text, file} = messageData;
    let filename = null;
    if (file) {
      console.log('size', file.data.length);
      const parts = file.name.split('.');
      const ext = parts[parts.length - 1];
      filename = Date.now() + '.'+ext;
      const path = __dirname + '/uploads/' + filename;
      const bufferData = new Buffer(file.data.split(',')[1], 'base64');
      fs.writeFile(path, bufferData, () => {
        console.log('file saved:'+path);
      });
    }
    if (recipient && (text || file)) {
      const messageDoc = await Message.create({
        sender:connection.userId,
        recipient,
        text,
        file: file ? filename : null,
        unread: true,
      });

      await User.updateOne({ _id: recipient }, { $inc: { unreadMessages: 1 } });

      [...wss.clients]
        .filter(c => c.userId === recipient)
        .forEach(c => c.send(JSON.stringify({
          text,
          sender:connection.userId,
          recipient,
          file: file ? filename : null,
          _id:messageDoc._id,
        })));
    }
  });

  notifyAboutOnlinePeople();
});
