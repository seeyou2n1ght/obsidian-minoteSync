

export interface NoteFolder {
	id: string;
	type: "folder";
	createDate: number;
	modifyDate: number;
	subject: string;
}

export interface NoteEntry {
	id: string;
	type: "note";
	createDate: number;
	modifyDate: number;
	subject: string;
	snippet: string;
	colorId: number;
	folderId: string;
	setting?: { data?: any[] };
	extraInfo?: string;
}

export interface NoteListResponse {
	result: "ok";
	data: {
		entries: NoteEntry[];
		folders: NoteFolder[];
		lastPage: boolean;
		syncTag: string;
	};
}

export interface NoteDetailResponse {
	result: "ok";
	data: {
		entry: NoteEntry & { content?: string, files?: any[] };
	};
}

let proxyWebview: any = null;

export function getProxyWebview(partition: string): Promise<any> {
	return new Promise((resolve) => {
		if (proxyWebview) {
			if (proxyWebview.getAttribute('partition') === partition) {
				return resolve(proxyWebview);
			} else {
				destroyProxyWebview();
			}
		}
		
		proxyWebview = document.createElement('webview') as any;
		proxyWebview.setAttribute('partition', partition);
		proxyWebview.setAttribute('src', 'https://i.mi.com/favicon.ico');
		proxyWebview.setAttribute('style', 'width: 0; height: 0; position: absolute; visibility: hidden;');
		
		proxyWebview.addEventListener('dom-ready', () => {
			resolve(proxyWebview);
		});
		
		document.body.appendChild(proxyWebview as Node);
	});
}

export function destroyProxyWebview() {
	if (proxyWebview) {
		proxyWebview.remove();
		proxyWebview = null;
	}
}

export class MiNoteAPI {
	partition: string;
	constructor(partition: string) {
		this.partition = partition;
	}

	public static async checkLoginStatus(partition: string): Promise<boolean> {
		try {
			const webview = await getProxyWebview(partition);
			await MiNoteAPI.ensureOrigin(webview);
			const val = await webview.executeJavaScript(`document.cookie.includes('userId=')`);
			return !!val;
		} catch(e) {
			return false;
		}
	}

	private static async ensureOrigin(webview: any): Promise<void> {
		try {
			let currentUrl = '';
			if (typeof webview.getURL === 'function') {
				currentUrl = webview.getURL();
			} else {
				currentUrl = await webview.executeJavaScript('window.location.href').catch(()=>'');
			}
			
			// 核心修复点：不要将隐形内核停留在 note/h5，因为其自带的 Vue 框架可能发生心跳重试或页面刷新
			// 一旦发生框架自发的页面跳转，我们正在执行的 await fetch 就会被 chromium 立马 abort 掉，并抛出 Failed to fetch
			// 故这里安全起见，我们把它泊车到同域名下毫无 JS 环境的静态图片上，这样就拥有了一个纯净无干扰的跨域请求跳板
			const targetEndpoint = 'https://i.mi.com/favicon.ico';

			if (!currentUrl.startsWith('https://i.mi.com') || currentUrl.includes('note/h5')) {
				webview.setAttribute('src', targetEndpoint);
				await new Promise<void>(resolve => {
					let isResolved = false;
					const done = () => {
						if (isResolved) return;
						isResolved = true;
						webview.removeEventListener('dom-ready', done);
						webview.removeEventListener('did-stop-loading', done);
						resolve();
					};
					// 静态资源在部分 Electron 中不抛 dom-ready 而是 did-stop-loading
					webview.addEventListener('dom-ready', done);
					webview.addEventListener('did-stop-loading', done);
					// 2秒强行超时放行，防止阻塞队列
					setTimeout(done, 2000);
				});
			}
		} catch (e) {
			console.error("MiNoteAPI ensureOrigin failed", e);
		}
	}

	private async request<T>(url: string): Promise<T> {
		const webview = await getProxyWebview(this.partition);
		await MiNoteAPI.ensureOrigin(webview);
		const result = await webview.executeJavaScript(`
			fetch('${url}').then(res => {
				if (!res.ok) throw new Error('Status ' + res.status);
				return res.json();
			})
		`);
		if (!result || result.code === 401) {
			throw new Error("UNAUTHORIZED");
		}
		return result;
	}

	public async getNoteList(syncTag?: string, limit = 200): Promise<NoteListResponse> {
		const ts = Date.now();
		const tagQuery = syncTag ? `&syncTag=${encodeURIComponent(syncTag)}` : '';
		const url = `https://i.mi.com/note/full/page/?ts=${ts}&limit=${limit}${tagQuery}`;
		return this.request<NoteListResponse>(url);
	}

	public async getNoteDetail(id: string): Promise<NoteDetailResponse> {
		const ts = Date.now();
		const url = `https://i.mi.com/note/note/${id}/?ts=${ts}`;
		return this.request<NoteDetailResponse>(url);
	}

	public async downloadAttachment(fileId: string): Promise<ArrayBuffer> {
		const url = `https://i.mi.com/file/full?fileid=${encodeURIComponent(fileId)}&type=note_img`;
		const webview = await getProxyWebview(this.partition);
		await MiNoteAPI.ensureOrigin(webview);
		// 通过结构化克隆直接穿透 Uint8Array 回主进程
		const uint8Array = await webview.executeJavaScript(`
			fetch('${url}')
				.then(res => res.arrayBuffer())
				.then(buf => Array.from(new Uint8Array(buf)))
		`);
		return new Uint8Array(uint8Array).buffer;
	}
}
