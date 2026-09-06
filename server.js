const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const rooms = new Map();

const RULES = {
  1: 'If two or more players choose the same number, that number is invalid. Those players lose 1 point even if their number is closest to the target.',
  2: 'Choosing the exact correct target number makes every other player lose 2 points instead of 1.',
  3: 'If one player chooses 0, another player can win by choosing 100.'
};

function makeCode() {
  let c;
  do {
    c = Math.random().toString(36).slice(2, 8).toUpperCase();
  } while (rooms.has(c));
  return c;
}

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function publicState(room, ws) {
  const me = room.players.find(p => p.ws === ws);

  return {
    type: 'state',
    room: room.code,
    hostId: room.hostId,
    started: room.started,
    round: room.round,
    phase: room.phase,
    myPicked: !!(me && room.picks.has(me.id)),
    ruleLevel: room.ruleLevel,
    newRule: room.newRule,
    ruleEndsAt: room.ruleEndsAt,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      points: p.points,
      eliminated: p.eliminated
    }))
  };
}

function broadcast(room) {
  room.players.forEach(p => {
    send(p.ws, publicState(room, p.ws));
  });
}

function resolveRound(room) {
  const active = room.players.filter(p => !p.eliminated);

  const picks = active.map(player => ({
    player,
    value: room.picks.get(player.id)
  }));

  const sum = picks.reduce((a, x) => a + x.value, 0);
  const average = sum / picks.length;
  const target = average * 0.8;

  const counts = {};
  picks.forEach(x => {
    counts[x.value] = (counts[x.value] || 0) + 1;
  });

  const invalid = new Set();

  if (room.ruleLevel >= 1) {
    picks.forEach(x => {
      if (counts[x.value] > 1) {
        invalid.add(x.player.id);
      }
    });
  }

  let winners = [];

  if (room.ruleLevel >= 3) {
    const choseZero = picks.filter(
      x => x.value === 0 && !invalid.has(x.player.id)
    );

    const choseHundred = picks.filter(
      x => x.value === 100 && !invalid.has(x.player.id)
    );

    if (choseZero.length === 1 && choseHundred.length > 0) {
      winners = choseHundred;
    }
  }

  if (!winners.length) {
    const valid = picks.filter(x => !invalid.has(x.player.id));
    const pool = valid.length ? valid : picks;

    const minimum = Math.min(
      ...pool.map(x => Math.abs(x.value - target))
    );

    winners = pool.filter(
      x => Math.abs(Math.abs(x.value - target) - minimum) < 1e-9
    );
  }

  const exactWinner =
    room.ruleLevel >= 2 &&
    winners.some(x => Math.abs(x.value - target) < 1e-9) &&
    winners.every(x => !invalid.has(x.player.id));

  const normalPenalty = exactWinner ? 2 : 1;

  picks.forEach(x => {
    const won =
      winners.some(w => w.player.id === x.player.id) &&
      !invalid.has(x.player.id);

    if (!won) {
      x.player.points -= invalid.has(x.player.id)
        ? 1
        : normalPenalty;
    }
  });

  const eliminated = [];

  room.players.forEach(player => {
    if (!player.eliminated && player.points <= -10) {
      player.eliminated = true;
      eliminated.push(player);
    }
  });

  const oldRuleLevel = room.ruleLevel;

  room.ruleLevel = Math.min(
    3,
    room.ruleLevel + eliminated.length
  );

  room.picks.clear();

  const remaining = room.players.filter(p => !p.eliminated);

  if (remaining.length <= 1) {
    room.phase = 'gameover';
  } else if (room.ruleLevel > oldRuleLevel) {
    room.phase = 'waitingRule';
  } else {
    room.phase = 'picking';
  }

  room.newRule =
    room.ruleLevel > oldRuleLevel
      ? RULES[room.ruleLevel]
      : null;

  room.ruleEndsAt =
    room.phase === 'waitingRule'
      ? Date.now() + 300000
      : 0;

  const result = {
    type: 'roundResult',
    phase: room.phase,
    round: room.round,
    average,
    target,

    winnerText:
      winners.length
        ? winners.map(x => x.player.name).join(' & ') +
          (winners.length > 1 ? ' tie!' : ' wins round!')
        : 'No valid winner.',

    picks: picks.map(x => ({
      name: x.player.name,
      value: x.value,
      distance: Math.abs(x.value - target),

      result: invalid.has(x.player.id)
        ? 'INVALID'
        : winners.some(w => w.player.id === x.player.id)
          ? 'WINNER'
          : 'LOSE'
    })),

    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      points: p.points,
      eliminated: p.eliminated
    })),

    eliminatedNames: eliminated.map(p => p.name),
    newRule: room.newRule,
    ruleEndsAt: room.ruleEndsAt
  };

  room.players.forEach(p => {
    send(p.ws, result);
  });
}

const server = http.createServer((req, res) => {
  let requested = req.url === '/'
    ? '/index.html'
    : req.url;

  if (requested.includes('..')) {
    res.writeHead(403);
    return res.end();
  }

  const filePath = path.join(
    __dirname,
    'public',
    requested
  );

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      return res.end('Not found');
    }

    const type =
      requested.endsWith('.html')
        ? 'text/html'
        : 'text/plain';

    res.writeHead(200, {
      'Content-Type': type
    });

    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {

  ws.on('message', raw => {
    let message;

    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.type === 'createRoom') {

      const room = {
        code: makeCode(),
        hostId: null,
        players: [],
        started: false,
        round: 1,
        phase: 'lobby',
        picks: new Map(),
        ruleLevel: 0,
        newRule: null,
        ruleEndsAt: 0
      };

      const player = {
        id: crypto.randomUUID(),
        name: String(message.name || 'Player').slice(0, 16),
        points: 0,
        eliminated: false,
        ws
      };

      room.hostId = player.id;
      room.players.push(player);

      rooms.set(room.code, room);
      ws.room = room;

      send(ws, {
        type: 'roomCreated',
        room: {
          code: room.code,
          hostId: room.hostId
        },
        playerId: player.id
      });

      broadcast(room);
    }

    if (message.type === 'joinRoom') {

      const code =
        String(message.code || '').toUpperCase();

      const room = rooms.get(code);

      if (!room) {
        return send(ws, {
          type: 'error',
          message: 'Room not found.'
        });
      }

      if (room.started) {
        return send(ws, {
          type: 'error',
          message: 'Game already started.'
        });
      }

      if (room.players.length >= 5) {
        return send(ws, {
          type: 'error',
          message: 'Room is full (maximum 5 players).'
        });
      }

      const player = {
        id: crypto.randomUUID(),
        name: String(message.name || 'Player').slice(0, 16),
        points: 0,
        eliminated: false,
        ws
      };

      room.players.push(player);
      ws.room = room;

      send(ws, {
        type: 'roomJoined',
        room: {
          code: room.code,
          hostId: room.hostId
        },
        playerId: player.id
      });

      broadcast(room);
    }

    if (message.type === 'startGame') {

      const room = ws.room;
      const player =
        room?.players.find(p => p.ws === ws);

      if (
        room &&
        player &&
        player.id === room.hostId &&
        room.players.length >= 2
      ) {
        room.started = true;
        room.phase = 'picking';
        broadcast(room);
      }
    }

    if (message.type === 'pick') {

      const room = ws.room;
      const player =
        room?.players.find(p => p.ws === ws);

      const value = Number(message.value);

      if (
        !room ||
        room.phase !== 'picking' ||
        !player ||
        player.eliminated ||
        room.picks.has(player.id) ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > 100
      ) {
        return;
      }

      room.picks.set(player.id, value);

      broadcast(room);

      const allPicked =
        room.players
          .filter(p => !p.eliminated)
          .every(p => room.picks.has(p.id));

      if (allPicked) {
        resolveRound(room);
      }
    }

    if (message.type === 'nextRound') {

      const room = ws.room;
      const player =
        room?.players.find(p => p.ws === ws);

      if (
        room &&
        player &&
        player.id === room.hostId &&
        room.phase !== 'gameover' &&
        Date.now() >= room.ruleEndsAt
      ) {
        room.round++;
        room.phase = 'picking';
        room.newRule = null;
        room.picks.clear();

        broadcast(room);
      }
    }
  });

  ws.on('close', () => {

    const room = ws.room;

    if (!room) return;

    const player =
      room.players.find(p => p.ws === ws);

    if (player && !room.started) {
      room.players =
        room.players.filter(p => p !== player);
    } else if (player) {
      player.ws = null;
    }

    if (room.hostId === player?.id && room.players.length) {
      const connected =
        room.players.find(p => p.ws);

      room.hostId =
        connected?.id || room.players[0].id;
    }

    if (!room.players.length) {
      rooms.delete(room.code);
    } else {
      broadcast(room);
    }
  });
});

server.listen(PORT, () => {
  console.log(
    'Balance Scale multiplayer server running on port ' +
    PORT
  );
});
