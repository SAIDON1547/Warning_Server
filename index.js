const express = require("express");
const cron = require("node-cron");
const fs = require("fs");
const Ajv = require("ajv");
const request = require("request-promise");
const { Server } = require("socket.io");

const app = express();
app.use(express.json());
const http = require("http").createServer(app);
const io = new Server(http, {
  path: "/socket.io",
  cors: {
    origin: ["https://nikkorinyuki.com", "http://localhost:3000"],
    methods: ["GET", "POST"],
  },
});

const wait = async (ms) => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

let latest = "";
let nick = JSON.parse(fs.readFileSync("nick.json", "utf-8"));
const config = {
  sos: false, //グローバルなSOS値
  audio: "",
  text: "接近注意",
  backgrounds: [
    { Type: 1, Value: "#ffff00ff" },
    { Type: 1, Value: "#000000ff" },
  ],
};
let restore = false;

const ajv = new Ajv();
const validate_backgrounds = ajv.compile({
  type: "array",
  items: {
    type: "object",
    properties: {
      Type: { type: "integer" },
      Value: { type: "string" },
    },
    required: ["Type", "Value"],
  },
});

async function clients() {
  return (await io.sockets.in("client").fetchSockets()).map((e) => {
    return { ...e.data, nick: nick[e.data.mac] };
  });
}

async function main() {
  await new Promise((resolve, reject) => {
    request({
      url: "https://nikkorinyuki.com/tools/warring/version.txt?unNotify=true",
      method: "GET",
    })
      .then(function (body) {
        console.log(body);
        latest = body;
        resolve();
      })
      .catch(function (err) {
        console.log(err);
        reject();
      });
  });

  cron.schedule("30 * * * *", () => {});

  io.on("connection", async (socket) => {
    console.log(socket.handshake.address);

    //configはまとめる！！！
    console.log("connected");

    socket.on("ping", () => socket.emit("pong"));

    socket.once("client", async (data) => {
      //{mac,version,username,sos,download}
      const old = (await io.sockets.in("client").fetchSockets()).find(
        (e) => e.data.mac == data.mac
      );
      old?.emit("close");
      old?.disconnect();
      socket.data = Object.assign(
        socket.data ?? { sos: false, playError: false },
        data
      );
      socket.join("client");
      socket.emit("config", config);
      socket.to("server").emit("clients", await clients());
    });

    socket.on("type", async (type) => {
      if (type == "server") {
        socket.leave("client");
        socket.join("server");
        socket.emit("config", config);
        socket.emit("clients", await clients());
        //socket.emit("sos", { global: config.sos });
      } else {
        socket.leave("server");
        socket.join("client");
      }
    });

    socket.once("restore", (data, callback) => {
      if (restore) {
        if (callback) callback();
        return;
      }
      restore = true;
      /*
            {sos:true,config:{...}}
            */
      if (typeof data.sos == "boolean") socket.data.sos = data.sos;
      config.audio = data.config.audio ?? "";
      config.text = data.config.text ?? "接近注意";
      if (
        data.config.backgrounds &&
        validate_backgrounds(data.config.backgrounds)
      )
        config.backgrounds = data.config.backgrounds;
      config.sos = data.config.sos ?? false;
      socket.broadcast.emit("config", config);
      if (callback) callback();
    });

    socket.on("sos", async (data) => {
      // serverからON/OFF命令
      //{ sos:boolean, global:boolean, mac:string[] }
      if (!socket.rooms.has("server")) return;
      if (data?.global == true) {
        config.sos = data.sos;
        io.emit("sos", {
          global: data.sos,
        });
      } else if (data.mac?.length > 0) {
        const sockets = await io.sockets.in("client").fetchSockets();
        sockets
          .filter((s) => data.mac.includes(s.data.mac))
          .forEach((s) => s.emit("sos", { sos: data.sos }));
      }
    });

    socket.on("set_nick", async (data) => {
      if (!socket.rooms.has("server")) return;
      if (data.nick == "") {
        delete nick[data.mac];
      } else {
        nick[data.mac] = data.nick;
      }
      fs.writeFileSync("nick.json", JSON.stringify(nick));
      io.to("server").emit("clients", await clients());
    });

    socket.on("close", async (data) => {
      const s = (await io.sockets.in("client").fetchSockets()).find(
        (e) => e.data.mac == data.mac
      );
      s.emit("close");
      //close信号を受信したclientは、プロセスの終了を試みます。
    });

    socket.on("update", async (data) => {
      if (socket.rooms.has("server")) {
        io.emit("update");
        return;
      }
      if (typeof data.playError == "boolean")
        socket.data.playError = data.playError;
      if (typeof data.sos == "boolean") socket.data.sos = data.sos;
      socket.to("server").emit("clients", await clients());
      // ToDo: client add remove に変える
    });

    socket.on("config", (data) => {
      if (data.audio != undefined) config.audio = String(data.audio);
      if (data.text != undefined) config.text = String(data.text);
      if (data.backgrounds && validate_backgrounds(data.backgrounds))
        config.backgrounds = data.backgrounds;
      socket.broadcast.emit("config", data);
    });

    socket.on("volume", async (data) => {
      if (!socket.rooms.has("server")) return;
      const s = (await io.sockets.in("client").fetchSockets()).find(
        (s) => s.data.mac == data.mac
      );
      s.emit("volume", data.volume);
    });

    socket.on("disconnect", async (reason, description) => {
      console.log("disconnect", reason, description);
      io.to("server").emit("clients", await clients());
    });
  });

  app.post("/earthquake", async (req, res) => {
    console.log(req.body);
    config.text = req.body.text ?? "緊急地震速報";
    config.audio =
      "https://commons.nicovideo.jp/api/preview/get?cid=99687&content_type=mp3";
    config.backgrounds = [
      { Type: 1, Value: "#ffff00ff" },
      { Type: 1, Value: "#000000ff" },
    ];
    config.sos = true;
    io.emit("config", config);
    io.emit("sos", { global: true });
  });

  http.listen(8000, () => {
    console.log("Express server listening on port 8000");
  });
}

main();
