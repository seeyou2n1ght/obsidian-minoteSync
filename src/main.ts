import { App, Plugin, PluginSettingTab, Setting, Notice, Platform } from 'obsidian';
import { SyncEngine, SyncState } from './sync';
import { XiaomiLoginModal } from './login';
import { MiNoteAPI, destroyProxyWebview } from './api';

interface MiNoteSyncSettings {
	noteFolder: string;
	attachmentFolder: string;
	attachmentMode: 'local' | 'online';
	partition: string;
	syncOnStartup: boolean;
	outputMode: 'individual' | 'aggregate';
	fileNameTemplate: string;
	frontmatterTemplate: string;
	dateFormat: string;
	aggregateFilePath: string;
	noteTemplate: string;
	disableOnMobile: boolean;
	dailySyncEnabled: boolean;
	dailySyncAuto: boolean;
	dailySyncMethod: 'append' | 'cursor' | 'heading';
	dailySyncHeading: string;
	dailyNoteTemplate: string;
	syncState: SyncState;
}

const DEFAULT_SETTINGS: MiNoteSyncSettings = {
	noteFolder: 'MiNotes',
	attachmentFolder: 'MiNotes/Attachments',
	attachmentMode: 'local',
	partition: 'persist:minotesync_default',
	syncOnStartup: false,
	outputMode: 'individual',
	fileNameTemplate: '{{createTime}}_{{title}}',
	frontmatterTemplate: 'mi-note-id: {{id}}\nmi-note-folder: {{folder}}\ncreated: {{createTime}}\nmodified: {{modifyTime}}',
	dateFormat: 'YYYY-MM-DD_HH-mm-ss',
	aggregateFilePath: 'MiNotes/全量笔记.md',
	noteTemplate: '## {{title}}\n> 📁 {{folder}}  |  🕐 {{createTime}}\n\n{{content}}\n\n---',
	disableOnMobile: false,
	dailySyncEnabled: false,
	dailySyncAuto: false,
	dailySyncMethod: 'append',
	dailySyncHeading: '## 小米笔记',
	dailyNoteTemplate: '> [{{time}}] {{title}}\n\n{{content}}\n\n---',
	syncState: {
		lastSyncTime: 0,
		syncTag: '',
		notes: {},
		folders: {}
	}
}

export default class MiNoteSyncPlugin extends Plugin {
	settings: MiNoteSyncSettings;
	isSyncing: boolean = false;
	statusBarItem: HTMLElement;

	async onload() {
		await this.loadSettings();

		if (Platform.isMobile && this.settings.disableOnMobile) {
			console.log('MiNoteSync: 移动端已禁用此插件。');
			return;
		}
		
		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.setText('');

		const runSync = async () => {
			if (this.isSyncing) {
				new Notice('⚠️ 同步任务正在紧密执行中，请不要重复点击...');
				return;
			}
			this.isSyncing = true;
			this.statusBarItem.setText('⏳ 小米笔记同步中...');

			try {
				const engine = new SyncEngine(
					this.app,
					this.settings.partition,
					this.settings.noteFolder,
					this.settings.attachmentFolder,
					this.settings.attachmentMode,
					this.settings.syncState,
					async (state) => {
						this.settings.syncState = state;
						await this.saveSettings();
					},
					(msg: string) => {
						this.statusBarItem.setText(msg);
					},
					this.settings.fileNameTemplate,
					this.settings.frontmatterTemplate,
					this.settings.dateFormat,
					this.settings.outputMode,
					this.settings.aggregateFilePath,
					this.settings.noteTemplate,
					this.settings.dailySyncAuto,
					this.settings.dailySyncMethod,
					this.settings.dailySyncHeading,
					this.settings.dailyNoteTemplate
				);
				await engine.runSync();
			} finally {
				this.isSyncing = false;
				setTimeout(() => this.statusBarItem.setText(''), 5000);
			}
		};

		// 添加侧边栏图标
		this.addRibbonIcon('refresh-cw', 'Sync Mi Notes', async (evt: MouseEvent) => {
			await runSync();
		});

		// 添加快捷指令
		this.addCommand({
			id: 'sync-mi-notes',
			name: 'Sync Mi Notes',
			callback: async () => {
				await runSync();
			}
		});

		const runDailySync = async () => {
			if (this.isSyncing) {
				new Notice('⚠️ 同步任务进行中...');
				return;
			}
			this.isSyncing = true;
			this.statusBarItem.setText('⏳ 正在同步至日记...');
			try {
				const engine = new SyncEngine(
					this.app,
					this.settings.partition,
					this.settings.noteFolder,
					this.settings.attachmentFolder,
					this.settings.attachmentMode,
					this.settings.syncState,
					async (state) => {
						this.settings.syncState = state;
						await this.saveSettings();
					},
					(msg: string) => this.statusBarItem.setText(msg),
					this.settings.fileNameTemplate,
					this.settings.frontmatterTemplate,
					this.settings.dateFormat,
					this.settings.outputMode,
					this.settings.aggregateFilePath,
					this.settings.noteTemplate,
					this.settings.dailySyncAuto,
					this.settings.dailySyncMethod,
					this.settings.dailySyncHeading,
					this.settings.dailyNoteTemplate
				);
				await engine.syncToDailyNote(
					this.settings.dailySyncMethod,
					this.settings.dailySyncHeading,
					this.settings.dailyNoteTemplate
				);
			} finally {
				this.isSyncing = false;
				setTimeout(() => this.statusBarItem.setText(''), 5000);
			}
		};

		if (this.settings.dailySyncEnabled) {
			this.addRibbonIcon('list-plus', 'Sync to Daily Note (MiNote2Daily)', async () => {
				await runDailySync();
			});

			this.addCommand({
				id: 'minote-2-daily',
				name: 'Sync Mi Notes to Daily Note',
				callback: async () => {
					await runDailySync();
				}
			});
		}

		// 添加设置面板
		this.addSettingTab(new MiNoteSyncSettingTab(this.app, this));

		// 保证在 Obsidian 完全加载并构建好 UI 布局后再启动自动任务
		this.app.workspace.onLayoutReady(() => {
			if (this.settings.syncOnStartup) {
				runSync();
			}
		});
	}

	onunload() {
		destroyProxyWebview();
	}

	async loadSettings() {
		const data = await this.loadData();
		// 向下兼容：清除从旧版带过来的多余历史 cookie，以免残留在本地物理 data.json 里防碍用户的隐私审查
		if (data && data.cookie !== undefined) {
			delete data.cookie;
			await this.saveData(data); // flush clear
		}
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class MiNoteSyncSettingTab extends PluginSettingTab {
	plugin: MiNoteSyncPlugin;

	constructor(app: App, plugin: MiNoteSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		const authContainer = containerEl.createDiv();
		this.renderAuthSection(authContainer);

		// ── 同步行为 ──
		containerEl.createEl('h3', {text: '⚡️ 同步行为'});

		new Setting(containerEl)
			.setName('启动时自动同步')
			.setDesc('打开 Obsidian 时，后台静默执行一次增量同步，无需手动触发。')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncOnStartup)
				.onChange(async (value) => {
					this.plugin.settings.syncOnStartup = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('移动端禁用')
			.setDesc('在移动端启动时自动禁用插件，避免不必要的资源占用。')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.disableOnMobile)
				.onChange(async (value) => {
					this.plugin.settings.disableOnMobile = value;
					await this.plugin.saveSettings();
				}));

		// ── 附件设置 ──
		containerEl.createEl('h3', {text: '📎 附件设置'});
		const attachmentSection = containerEl.createDiv();
		const renderAttachmentSection = () => {
			attachmentSection.empty();

			new Setting(attachmentSection)
				.setName('附件处理方式')
				.setDesc('「下载至本地」可永久保留；「在线链接」省空间但存在防盗链失效风险。')
				.addDropdown(dropdown => dropdown
					.addOption('local', '⬇️ 下载并保存至本地 (推荐)')
					.addOption('online', '🔗 作为在线链接插入')
					.setValue(this.plugin.settings.attachmentMode)
					.onChange(async (value: 'local' | 'online') => {
						this.plugin.settings.attachmentMode = value;
						await this.plugin.saveSettings();
						renderAttachmentSection();
					}));

			if (this.plugin.settings.attachmentMode === 'local') {
				new Setting(attachmentSection)
					.setName('附件目录')
					.setDesc('图片、音频等附件存放目录')
					.addText(text => text
						.setPlaceholder('MiNotes/Attachments')
						.setValue(this.plugin.settings.attachmentFolder)
						.onChange(async (value) => {
							this.plugin.settings.attachmentFolder = value;
							await this.plugin.saveSettings();
						}));
			}
		};
		renderAttachmentSection();

		// ── 输出格式与模板 ──
		containerEl.createEl('h3', {text: '📝 输出格式与模板'});

		const templateSection = containerEl.createDiv();
		const renderTemplateSection = () => {
			templateSection.empty();
			const isIndividual = this.plugin.settings.outputMode === 'individual';

			new Setting(templateSection)
				.setName('输出模式')
				.setDesc('「分文件」：每篇笔记生成独立 .md；「聚合」：所有笔记合并写入同一文件。')
				.addDropdown(dd => dd
					.addOption('individual', '📄 分文件（每篇独立）')
					.addOption('aggregate', '📚 聚合单文件')
					.setValue(this.plugin.settings.outputMode)
					.onChange(async (value: 'individual' | 'aggregate') => {
						this.plugin.settings.outputMode = value;
						await this.plugin.saveSettings();
						renderTemplateSection();
					}));

			if (isIndividual) {
				new Setting(templateSection)
					.setName('笔记目录')
					.setDesc('同步的笔记存放在哪个文件夹')
					.addText(text => text
						.setPlaceholder('MiNotes')
						.setValue(this.plugin.settings.noteFolder)
						.onChange(async (value) => {
							this.plugin.settings.noteFolder = value;
							await this.plugin.saveSettings();
						}));

				new Setting(templateSection)
					.setName('时间格式')
					.setDesc('遵循 moment.js 规范（如 YYYY-MM-DD HH:mm）')
					.addText(text => text
						.setPlaceholder('YYYY-MM-DD_HH-mm-ss')
						.setValue(this.plugin.settings.dateFormat)
						.onChange(async (value) => {
							this.plugin.settings.dateFormat = value;
							await this.plugin.saveSettings();
						}));

				new Setting(templateSection)
					.setName('文件命名规则')
					.setDesc('笔记文件的命名规则')
					.addText(text => {
						text.setPlaceholder('{{createTime}}_{{title}}')
							.setValue(this.plugin.settings.fileNameTemplate)
							.onChange(async (value) => {
								this.plugin.settings.fileNameTemplate = value;
								await this.plugin.saveSettings();
							});
						
						this.renderVariableHelper(templateSection, text.inputEl, ['id', 'title', 'folder', 'createTime', 'modifyTime', 'color'], async (val) => {
							this.plugin.settings.fileNameTemplate = val;
							await this.plugin.saveSettings();
						});
					});

				new Setting(templateSection)
					.setName('YAML Frontmatter 模板')
					.setDesc('每篇笔记顶部注入的属性块。可用变量同上。')
					.addTextArea(text => {
						text.inputEl.rows = 6;
						text.inputEl.style.width = '100%';
						text.inputEl.style.fontFamily = 'monospace';
						text.setValue(this.plugin.settings.frontmatterTemplate)
							.onChange(async (value) => {
								this.plugin.settings.frontmatterTemplate = value;
								await this.plugin.saveSettings();
							});
						
						this.renderVariableHelper(templateSection, text.inputEl, ['id', 'title', 'folder', 'createTime', 'modifyTime', 'color'], async (val) => {
							this.plugin.settings.frontmatterTemplate = val;
							await this.plugin.saveSettings();
						});
					});
			} else {
				new Setting(templateSection)
					.setName('时间格式')
					.setDesc('遵循 moment.js 规范（如 YYYY-MM-DD HH:mm）')
					.addText(text => text
						.setPlaceholder('YYYY-MM-DD_HH-mm-ss')
						.setValue(this.plugin.settings.dateFormat)
						.onChange(async (value) => {
							this.plugin.settings.dateFormat = value;
							await this.plugin.saveSettings();
						}));

				new Setting(templateSection)
					.setName('聚合文件路径')
					.setDesc('所有笔记写入此 .md 文件（相对知识库根目录）')
					.addText(text => text
						.setPlaceholder('MiNotes/全量笔记.md')
						.setValue(this.plugin.settings.aggregateFilePath)
						.onChange(async (value) => {
							this.plugin.settings.aggregateFilePath = value;
							await this.plugin.saveSettings();
						}));

				new Setting(templateSection)
					.setName('笔记段落模板')
					.setDesc('每篇笔记在聚合文件里的渲染形式。')
					.addTextArea(text => {
						text.inputEl.rows = 7;
						text.inputEl.style.width = '100%';
						text.inputEl.style.fontFamily = 'monospace';
						text.setValue(this.plugin.settings.noteTemplate)
							.onChange(async (value) => {
								this.plugin.settings.noteTemplate = value;
								await this.plugin.saveSettings();
							});

						this.renderVariableHelper(templateSection, text.inputEl, ['id', 'title', 'folder', 'createTime', 'modifyTime', 'color', 'content'], async (val) => {
							this.plugin.settings.noteTemplate = val;
							await this.plugin.saveSettings();
						});
					});
			}
		};
		renderTemplateSection();

		// ── MiNote2Daily ──
		if (this.plugin.settings.dailySyncEnabled) {
			containerEl.createEl('h3', {text: '📅 小米笔记转日记 (MiNote2Daily)'});
			
			new Setting(containerEl)
				.setName('同步方式')
				.setDesc('自动同步：随主流程自动抓取当日笔记并追加；手动：点击侧边栏或执行指令触发。')
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.dailySyncAuto)
					.onChange(async (value) => {
						this.plugin.settings.dailySyncAuto = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('插入位置')
				.setDesc('「追加」：日记末尾；「标题」：指定标题下方；「光标」：当前编辑位置。')
				.addDropdown(dd => dd
					.addOption('append', '⬇️ 追加到末尾')
					.addOption('heading', '📌 指定标题下方')
					.addOption('cursor', '🖱️ 插入至当前光标处')
					.setValue(this.plugin.settings.dailySyncMethod)
					.onChange(async (value: 'append' | 'heading' | 'cursor') => {
						this.plugin.settings.dailySyncMethod = value;
						await this.plugin.saveSettings();
						this.display();
					}));

			if (this.plugin.settings.dailySyncMethod === 'heading') {
				new Setting(containerEl)
					.setName('目标标题')
					.setDesc('例如 ## 小米笔记。插件将在此标题下方插入内容。')
					.addText(text => text
						.setPlaceholder('## 小米笔记')
						.setValue(this.plugin.settings.dailySyncHeading)
						.onChange(async (value) => {
							this.plugin.settings.dailySyncHeading = value;
							await this.plugin.saveSettings();
						}));
			}

			new Setting(containerEl)
				.setName('日记插入模板')
				.setDesc('同步至日记时的内容格式。支持 {{time}} 等变量。')
				.addTextArea(text => {
					text.inputEl.rows = 4;
					text.inputEl.style.width = '100%';
					text.inputEl.style.fontFamily = 'monospace';
					text.setValue(this.plugin.settings.dailyNoteTemplate)
						.onChange(async (value) => {
							this.plugin.settings.dailyNoteTemplate = value;
							await this.plugin.saveSettings();
						});
					
					this.renderVariableHelper(templateSection, text.inputEl, ['time', 'title', 'folder', 'content'], async (val) => {
						this.plugin.settings.dailyNoteTemplate = val;
						await this.plugin.saveSettings();
					});
				});
		}

		new Setting(containerEl)
			.setName('启用 MiNote2Daily')
			.setDesc('开启后，支持将当日小米笔记快速同步到日记文件中。')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.dailySyncEnabled)
				.onChange(async (value) => {
					this.plugin.settings.dailySyncEnabled = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		// ── 同步控制 ──
		containerEl.createEl('h3', {text: '🔄 同步控制'});

		new Setting(containerEl)
			.setName('强制全量同步')
			.setDesc('清空增量历史记录，重新拉取所有云端笔记。适合本地误删或云端大批量整理后使用。')
			.addButton(btn => btn
				.setButtonText('立即全量同步')
				.setWarning()
				.onClick(async () => {
					if (this.plugin.isSyncing) {
						new Notice('⚠️ 同步任务进行中，请等待完成再试！');
						return;
					}
					
					btn.setDisabled(true);
					btn.setButtonText('初始化中...');
					this.plugin.isSyncing = true;
					this.plugin.statusBarItem.setText('⏳ 强制全量同步中...');
					
					try {
						this.plugin.settings.syncState = { lastSyncTime: 0, syncTag: '', notes: {}, folders: {} };
					await this.plugin.saveSettings();
					
					const engine = new SyncEngine(
						this.app,
						this.plugin.settings.partition,
						this.plugin.settings.noteFolder,
						this.plugin.settings.attachmentFolder,
						this.plugin.settings.attachmentMode,
						this.plugin.settings.syncState,
						async (state) => {
							this.plugin.settings.syncState = state;
							await this.plugin.saveSettings();
						},
						(msg: string) => {
							this.plugin.statusBarItem.setText(msg);
						},
						this.plugin.settings.fileNameTemplate,
						this.plugin.settings.frontmatterTemplate,
						this.plugin.settings.dateFormat,
						this.plugin.settings.outputMode,
						this.plugin.settings.aggregateFilePath,
						this.plugin.settings.noteTemplate,
						this.plugin.settings.dailySyncAuto,
						this.plugin.settings.dailySyncMethod,
						this.plugin.settings.dailySyncHeading,
						this.plugin.settings.dailyNoteTemplate
					);
					await engine.runSync();
					btn.setButtonText('已完成');
					} finally {
						this.plugin.isSyncing = false;
						setTimeout(() => btn.setDisabled(false).setButtonText('立即执行全量同步'), 3000);
						setTimeout(() => this.plugin.statusBarItem.setText(''), 5000);
					}
				}));
	}

	private renderVariableHelper(containerEl: HTMLElement, targetInput: HTMLTextAreaElement | HTMLInputElement, variables: string[], onUpdate: (val: string) => void) {
		const helperEl = containerEl.createDiv();
		helperEl.style.marginTop = '8px';
		helperEl.style.display = 'flex';
		helperEl.style.flexWrap = 'wrap';
		helperEl.style.gap = '6px';

		variables.forEach(variable => {
			const btn = helperEl.createEl('button', { 
				text: `{{${variable}}}`
			});
			btn.style.fontSize = '0.75em';
			btn.style.padding = '2px 8px';
			btn.style.cursor = 'pointer';
			btn.style.borderRadius = '4px';
			btn.style.border = '1px solid var(--background-modifier-border)';
			btn.style.backgroundColor = 'var(--background-secondary)';
			
			btn.addEventListener('click', (e) => {
				e.preventDefault();
				const start = targetInput.selectionStart || 0;
				const end = targetInput.selectionEnd || 0;
				const text = targetInput.value;
				const insertion = `{{${variable}}}`;
				
				targetInput.value = text.substring(0, start) + insertion + text.substring(end);
				targetInput.selectionStart = targetInput.selectionEnd = start + insertion.length;
				targetInput.focus();
				
				onUpdate(targetInput.value);
			});
		});
	}

	async renderAuthSection(container: HTMLElement) {
		container.empty();
		
		if (!this.plugin.settings.partition) {
			this.plugin.settings.partition = 'persist:minotesync_default';
			await this.plugin.saveSettings();
		}

		const loginDesc = new Setting(container)
			.setName('小米云授权状态 🔐')
			.setDesc('⏳ 正在极速连接安全沙盒检查会话状态，请稍候...');

		const isLogin = await MiNoteAPI.checkLoginStatus(this.plugin.settings.partition);

		loginDesc.setDesc(isLogin 
				? '✅ 我们已从原生安全沙盒中确认您的登录状态有效。您可以毫无顾虑地进行同步！' 
				: '❌ 未登录。支持集成原生加密浏览模块进行鉴权。您可以随时一键彻底清空本地所有会话信息以保护隐私。');

		if (isLogin) {
			loginDesc.addButton(btn => btn
				.setButtonText('清除授权信息')
				.setWarning()
				.onClick(async () => {
					btn.setDisabled(true);
					btn.setButtonText('正在清理...');
					
					// Partition 轮转架构：直接分配一个新的隔离区，抛弃存在 Cookie 缓存的旧区
					this.plugin.settings.partition = 'persist:minotesync_' + Date.now();
					await this.plugin.saveSettings();
					
					// 干掉后台挂载的含有旧登录态的实例
					destroyProxyWebview();

					new Notice('✅ 本地沙盒中的旧区已整体舍弃更换！您的隐私已彻底粉碎，再次同步前需重新鉴权扫码。', 5000);
					this.renderAuthSection(container);
				}));
		} else {
			loginDesc.addButton(btn => btn
				.setButtonText('点击前往授权')
				.setCta()
				.onClick(() => {
					new XiaomiLoginModal(this.app, this.plugin.settings.partition, () => {
						new Notice('🎉 小米云服务认证成功！如果您是在公共设备上使用，可以在离开前点击清除授权以保护隐私。');
						this.renderAuthSection(container); 
					}).open();
				}));
		}
	}
}
