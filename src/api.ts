

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
		
		// dom-ready 触发后正常 resolve
		proxyWebview.addEventListener('dom-ready', () => {
			resolve(proxyWebview);
		});

		// 超时兜底：防止网络异常导致 dom-ready 永远不触发而阻塞整个插件
		setTimeout(() => resolve(proxyWebview), 8000);
		
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
			
			// 1. 初始化探测：如果在静态图片锚点上已经有 userId，直接放行
			let val = await webview.executeJavaScript(`document.cookie.includes('userId=')`);
			if (val) return true;

			// 2. 如果没有，说明 session 丢失了，但持久化 token 可能还活着
			// 驱使代理内核前往业务主页激发 SSO 的 302 洗白刷新机制
			return await new Promise<boolean>((resolve) => {
				let resolved = false;
				const done = (result: boolean) => {
					if (resolved) return;
					resolved = true;
					webview.removeEventListener('did-navigate', onNavigate);
					resolve(result);
				};

				const onNavigate = async (e: any) => {
					if (resolved) return;
					if (e.url.includes('i.mi.com/note/h5')) {
						// 试图检测此时是否已经重新签发了 userId
						const hasUserId = await webview.executeJavaScript(`document.cookie.includes('userId=')`).catch(()=>false);
						if (hasUserId) done(true);
					} else if (e.url.includes('account.xiaomi.com/pass/serviceLogin')) {
						// 确实掉线了，服务端将请求打回了统一账密登录页
						done(false);
					}
				};

				webview.addEventListener('did-navigate', onNavigate);
				webview.setAttribute('src', 'https://i.mi.com/note/h5');

				// 给足 8 秒钟时间让内核完成 302 重定向回路，超时视为须重新手动授权
				setTimeout(() => done(false), 8000);
			});
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

	private async request<T>(url: string, timeoutMs = 30000): Promise<T> {
		const webview = await getProxyWebview(this.partition);
		await MiNoteAPI.ensureOrigin(webview);

		// 使用 JSON.stringify 转义 URL 参数，防止因 URL 中含有引号等特殊字符导致的代码注入风险
		const fetchPromise = webview.executeJavaScript(`
			fetch(${JSON.stringify(url)}).then(res => {
				if (!res.ok) throw new Error('Status ' + res.status);
				return res.json();
			})
		`);

		// 请求超时兜底：防止 Webview 卡死、网络无响应等场景导致 Promise 永远不 resolve
		const timeoutPromise = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error(`请求超时 (${timeoutMs}ms): ${url.substring(0, 80)}`)), timeoutMs)
		);

		const result = await Promise.race([fetchPromise, timeoutPromise]);

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

	public async downloadAttachment(fileId: string, timeoutMs = 60000): Promise<ArrayBuffer> {
		const url = `https://i.mi.com/file/full?fileid=${encodeURIComponent(fileId)}&type=note_img`;
		const webview = await getProxyWebview(this.partition);
		await MiNoteAPI.ensureOrigin(webview);

		// 使用 JSON.stringify 转义 URL，与 request 方法保持一致
		const fetchPromise = webview.executeJavaScript(`
			fetch(${JSON.stringify(url)})
				.then(res => res.arrayBuffer())
				.then(buf => Array.from(new Uint8Array(buf)))
		`);

		// 附件下载超时兜底（默认 60s，大文件需要更长时间）
		const timeoutPromise = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error(`附件下载超时 (${timeoutMs}ms): ${fileId}`)), timeoutMs)
		);

		const uint8Array = await Promise.race([fetchPromise, timeoutPromise]);
		return new Uint8Array(uint8Array).buffer;
	}
}
