/*
 * Server side game module. Maintains the game state and processes all the messages from clients.
 *
 * Exports:
 *   - addPlayer(name)
 *   - move(direction, name)
 *   - state()
 */

const { clamp, randomPoint, permutation } = require('./gameutil');

// https://www.npmjs.com/package/redis
const redis = require('redis');

const bluebird = require('bluebird');
bluebird.promisifyAll(redis.RedisClient.prototype);

const client = redis.createClient();
client.on('error', err => console.log(`Error ${err}`));

const WIDTH = 64;
const HEIGHT = 64;
const MAX_PLAYER_NAME_LENGTH = 32;
const NUM_COINS = 100;

// A KEY-VALUE "DATABASE" FOR THE GAME STATE.
//
// The game state is maintained in an object. Your homework assignment is to swap this out
// for a Redis database.
//
// In this version, the players never die. For homework, you need to make a player die after
// five minutes of inactivity. You can use the Redis TTL for this.
//
// Here is how the storage is laid out:
//
// player:<name>    string       "<row>,<col>"
// scores           sorted set   playername with score
// coins            hash         { "<row>,<col>": coinvalue }
// usednames        set          all used names, to check quickly if a name has been used
//
/* const database = {
  scores: {},
  usednames: new Set(),
  coins: {},
}; */

exports.addPlayer = (name, io, socket) => {
  return client.sismemberAsync('usednames', name).then((res) => {
    if (res === 1 || name.length === 0 || name.length > MAX_PLAYER_NAME_LENGTH) {
      return false;
    } else {
      return client.saddAsync('usednames', name).then((res2) => {
        return client.setAsync(`player:${name}`, randomPoint(WIDTH, HEIGHT).toString()).then((res3) => {
          return client.zaddAsync('scores', 0, name).((res4) => {
            return true;
          });
        });
      });
    }
  });
};

function placeCoins() {
  permutation(WIDTH * HEIGHT).slice(0, NUM_COINS).forEach((position, i) => {
    const coinValue = (i < 50) ? 1 : (i < 75) ? 2 : (i < 95) ? 5 : 10;
    const index = `${Math.floor(position / WIDTH)},${Math.floor(position % WIDTH)}`;
    return client.hsetAsync('coins', index, coinValue).then((res) => {});
  });
}

// Return only the parts of the database relevant to the client. The client only cares about
// the positions of each player, the scores, and the positions (and values) of each coin.
// Note that we return the scores in sorted order, so the client just has to iteratively
// walk through an array of name-score pairs and render them.
exports.state = () => {
  const positions = [];
  const coins = [];
  const scores = [];
  return client.keysAsync('player:*').then((res) => {
    res.forEach((key) => {
      return client.getAsync(key).then((res2) => {
        positions.push([key.substring(7), res2]);
        return client.zrevrangeAsync('scores', 0, -1, 'WITHSCORES').then((res3) => {
          for (let i = 0; i < res3.length; i += 2) {
            scores[i] = [res3[i], res3[i + 1]];
          }
          return client.hkeysAsync('coins').then((res4) => {
            res4.forEach((key2) => {
              return client.hgetAsync('coins', key2).then((res5) => {
                coins.push([key2, res5]);
                return {
                  positions,
                  scores,
                  coins
                };
              });
            });
          });
        });
      });
    });
  };
}

exports.move = (direction, name) => {
  const delta = { U: [0, -1], R: [1, 0], D: [0, 1], L: [-1, 0] }[direction];
  if (delta) {
    const playerKey = `player:${name}`;
    let [x, y] = [0, 0];
    return client.getAsync(playerKey).then((res) => {
      [x, y] = res.split(',');
      const [newX, newY] = [clamp(+x + delta[0], 0, WIDTH - 1), clamp(+y + delta[1], 0, HEIGHT - 1)];
      return client.hgetAsync('coins', `${newX},${newY}`).then((res2) => {
        if (res2) {
          return client.zincrbyAsync('scores', res2, name).then((res3) => {
            return client.hdelAsync('coins', `${newX}, ${newY}`);
          });
        }
        return client.setAsync(playerKey, `${newX},${newY}`).then((res3) => {
          // When all coins collected, generate a new batch.
          return client.hlenAsync('coins').then((res4) => {
            if (res4 === 0) {
              placeCoins();
            }
          });
        });
      });
    });
  }
};

placeCoins();