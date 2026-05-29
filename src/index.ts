import {ComfortCloud} from "./ComfortCloud.js";

const client = new ComfortCloud('username', 'password');

const token = await client.login();
console.log(token)