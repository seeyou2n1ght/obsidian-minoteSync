import { App, Modal } from 'obsidian';

export class XiaomiLoginModal extends Modal {
	onLoginSuccess: () => void;
	partition: string;

	constructor(app: App, partition: string, onLoginSuccess: () => void) {
		super(app);
		this.partition = partition;
		this.onLoginSuccess = onLoginSuccess;
	}

	onOpen() {
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
			if (e.url.includes('i.mi.com/note/h5')) {
				webview.executeJavaScript(`
					new Promise((resolve) => {
						const check = () => {
							if (document.cookie.includes('userId=')) {
								resolve(true);
							} else {
								setTimeout(check, 500);
							}
						};
						check();
					})
				`).then((isLoggedIn: boolean) => {
					if (isLoggedIn) {
						this.onLoginSuccess();
						this.close();
					}
				});
			}
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}
