import { EventEmitter } from 'events';
import { Node, NodeMessage, NodeSocket } from 'veza';
import { Util } from 'discord.js';
import { ShardingManager } from '..';
import { isMaster } from 'cluster';

export class MasterIPC extends EventEmitter {
	[key: string]: any;
	public node: Node;

	constructor(public manager: ShardingManager) {
		super();
		this.node = new Node('Master')
			.on('client.identify', client => this.emit('debug', `[IPC] Client Connected: ${client.name}`))
			.on('client.disconnect', client => this.emit('debug', `[IPC] Client Disconnected: ${client.name}`))
			.on('client.destroy', client => this.emit('debug', `[IPC] Client Destroyed: ${client.name}`))
			.on('error', error => this.emit('error', error))
			.on('message', this._message.bind(this));
		if (isMaster) this.node.serve(manager.ipcSocket);
	}

	public async broadcast<T>(code: string): Promise<T[]> {
		const data = await this.node.broadcast({ event: '_eval', code });
		let errored = data.filter(res => !res.success);
		if (errored.length) {
			errored = errored.map(msg => msg.data);
			const error = errored[0];
			throw Util.makeError(error);
		}
		return data.map(res => res.data);
	}

	private _message(message: NodeMessage) {
		const { event }: { event: string } = message.data;
		this[event](message);
	}

	private async _broadcast(message: NodeMessage) {
		const { code } = message.data;
		try {
			const data = await this.broadcast(code);
			message.reply({ success: true, data });
		} catch (error) {
			message.reply({ success: false, data: { name: error.name, message: error.message, stack: error.stack } });
		}
	}

	private _ready(message: NodeMessage) {
		const { id } = message.data;
		const cluster = this.manager.clusters.get(id)!;
		cluster.ready = true;
		this.manager.clusters.set(id, cluster);
		this.manager.emit('debug', `Cluster ${id} became ready`);
		this.manager.emit('ready', cluster);
	}

	private _shardReady(message: NodeMessage) {
		const { shardID } = message.data;
		this.manager.emit('debug', `Shard ${shardID} became ready`);
		this.manager.emit('shardReady', shardID);
	}

	private _shardReconnect(message: NodeMessage) {
		const { shardID } = message.data;
		this.manager.emit('debug', `Shard ${shardID} tries to reconnect`);
		this.manager.emit('shardReconnect', shardID);
	}

	private _shardResumed(message: NodeMessage) {
		const { shardID } = message.data;
		this.manager.emit('debug', `Shard ${shardID} resumed connection`);
		this.manager.emit('shardResumed', shardID);
	}

	private _shardDisconnect(message: NodeMessage) {
		const { shardID } = message.data;
		this.manager.emit('debug', `Shard ${shardID} disconnected!`);
		this.manager.emit('shardDisconnect', shardID);
	}

	private _restart(message: NodeMessage) {
		const { clusterID } = message.data;
		return this.manager.restart(clusterID)
			.then(() => message.reply({ success: true }))
			.catch(error => message.reply({ success: false, data: { name: error.name, message: error.message, stack: error.stack } }));
	}

	private async _masterEval(message: NodeMessage) {
		const { code } = message.data;
		try {
			const result = await this.manager.eval(code);
			return message.reply({ success: true, data: result });
		} catch (error) {
			return message.reply({ success: false, data: { name: error.name, message: error.message, stack: error.stack } });
		}
	}

	private _restartAll() {
		this.manager.restartAll();
	}

	private async _fetchUser(message: NodeMessage) {
		return this._fetch(message, 'const user = this.users.get({id}); user ? user.toJSON() : user;');
	}

	private async _fetchGuild(message: NodeMessage) {
		return this._fetch(message, 'const guild = this.guilds.get({id}); guild ? guild.toJSON() : guild;');
	}

	private _fetchChannel(message: NodeMessage) {
		return this._fetch(message, 'const channel = this.channels.get({id}); channel ? channel.toJSON() : channel;');
	}

	private async _fetch(message: NodeMessage, code: string) {
		const { id } = message.data;
		const result = await this.broadcast<any>(code.replace('{id}', id));
		const realResult = result.filter(r => r);
		if (realResult.length) {
			return message.reply({ success: true, data: realResult[0] });
		}
		return message.reply({ success: false });
	}
}
