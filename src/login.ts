import { App, Modal } from 'obsidian';

export class XiaomiLoginModal extends Modal {
	onLoginSuccess: () => void;
	partition: string;
	// 标记 Modal 是否已关闭，用于终止 Cookie 轮询避免内存泄漏
	private isDestroyed = false;

	constructor(app: App, partition: string, onLoginSuccess: () => void) {
		super(app);
		this.partition = partition;
		this.onLoginSuccess = onLoginSuccess;
	}

	onOpen() {
		this.isDestroyed = false;
		const { contentEl } = this;
		contentEl.empty();
		contentEl.style.padding = '0';
		contentEl.style.overflow = 'hidden';

		const header = contentEl.createDiv({ cls: 'modal-title' });
		header.setText('小米云服务安全鉴权');
		header.style.padding = '10px 20px';
		header.style.textAlign = 'center';
		header.style.fontWeight = 'bold';
		header.style.fontSize = '1.2em';
		header.style.borderBottom = '1px solid var(--background-modifier-border)';

		const webviewContainer = contentEl.createDiv();
		webviewContainer.style.width = '100%';
		const height = Math.min(650, window.innerHeight * 0.8);
		webviewContainer.style.height = `${height}px`;

		const webview = webviewContainer.createEl('webview' as any, {
			attr: {
				src: 'https://i.mi.com/note/h5',
				partition: this.partition
			}
		}) as any;
		
		webview.style.width = '100%';
		webview.style.height = '100%';
		webview.style.border = 'none';

		webview.addEventListener('did-navigate', (e: any) => {
			// Modal 已关闭则不再执行任何轮询
			if (this.isDestroyed) return;

			if (e.url.includes('i.mi.com/note/h5')) {
				webview.executeJavaScript(`
					new Promise((resolve, reject) => {
						let disposed = false;
						const check = () => {
							if (disposed) return reject('modal_closed');
							if (document.cookie.includes('userId=')) {
								resolve(true);
							} else {
								setTimeout(check, 500);
							}
						};
						check();
						// 30秒超时自动终止轮询，防止无限递归
						setTimeout(() => { disposed = true; reject('timeout'); }, 30000);
					})
				`).then((isLoggedIn: boolean) => {
					if (isLoggedIn && !this.isDestroyed) {
						this.onLoginSuccess();
						this.close();
					}
				}).catch(() => {
					// 轮询被取消或超时，静默忽略
				});
			}
		});
	}

	onClose() {
		this.isDestroyed = true;
		this.contentEl.empty();
	}
}
