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
	dailySyncLookbackHours: number;
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
	dailySyncLookbackHours: 24,
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

	createSyncEngine(onProgress: (msg: string) => void): SyncEngine {
		return new SyncEngine({
			app: this.app,
			partition: this.settings.partition,
			noteFolder: this.settings.noteFolder,
			attachmentFolder: this.settings.attachmentFolder,
			attachmentMode: this.settings.attachmentMode,
			state: this.settings.syncState,
			saveState: async (state: SyncState) => {
				this.settings.syncState = state;
				await this.saveSettings();
			},
			onProgress: onProgress,
			fileNameTemplate: this.settings.fileNameTemplate,
			frontmatterTemplate: this.settings.frontmatterTemplate,
			dateFormat: this.settings.dateFormat,
			outputMode: this.settings.outputMode,
			aggregateFilePath: this.settings.aggregateFilePath,
			noteTemplate: this.settings.noteTemplate,
			dailySyncAuto: this.settings.dailySyncAuto,
			dailySyncMethod: this.settings.dailySyncMethod,
			dailySyncHeading: this.settings.dailySyncHeading,
			dailyNoteTemplate: this.settings.dailyNoteTemplate,
			dailySyncLookbackHours: this.settings.dailySyncLookbackHours
		});
	}

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
				new Notice('⚠️ 同步任务正在运行中，请勿重复操作。');
				return;
			}
			this.isSyncing = true;
			this.statusBarItem.setText('⏳ 正在同步小米笔记...');

			try {
				const engine = this.createSyncEngine((msg: string) => {
					this.statusBarItem.setText(msg);
				});
				await engine.runSync();
			} finally {
				this.isSyncing = false;
				setTimeout(() => this.statusBarItem.setText(''), 5000);
			}
		};

		// 添加侧边栏图标
		this.addRibbonIcon('refresh-cw', '立即同步小米笔记', async (evt: MouseEvent) => {
			await runSync();
		});

		// 添加快捷指令
		this.addCommand({
			id: 'sync-mi-notes',
			name: '立即同步小米笔记',
			callback: async () => {
				await runSync();
			}
		});

		const runDailySync = async () => {
			if (this.isSyncing) {
				new Notice('⚠️ 同步任务正在运行中，请稍后再试。');
				return;
			}
			this.isSyncing = true;
			this.statusBarItem.setText('⏳ 正在同步笔记至日记...');
			try {
				const engine = this.createSyncEngine((msg: string) => {
					this.statusBarItem.setText(msg);
				});
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
			this.addRibbonIcon('list-plus', '同步至今日日记 (MiNote2Daily)', async () => {
				await runDailySync();
			});

			this.addCommand({
				id: 'minote-2-daily',
				name: '将小米笔记同步至今日日记',
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

		// ── 同步摘要卡片 ──
		const state = this.plugin.settings.syncState;
		const totalNotes = Object.keys(state.notes || {}).length;
		const lastSync = state.lastSyncTime > 0 ? window.moment(state.lastSyncTime).format('YYYY-MM-DD HH:mm:ss') : '尚未同步';

		const statusCard = containerEl.createDiv();
		statusCard.style.padding = '1rem';
		statusCard.style.backgroundColor = 'var(--background-secondary)';
		statusCard.style.borderRadius = '8px';
		statusCard.style.border = '1px solid var(--background-modifier-border)';
		statusCard.style.marginBottom = '2rem';
		
		statusCard.createEl('h3', { text: '📊 同步信息摘要', attr: { style: 'margin-top: 0;' } });
		statusCard.createEl('div', { text: `🕒 最后同步: ${lastSync}`, attr: { style: 'margin: 0.5rem 0;' } });
		statusCard.createEl('div', { text: `📚 已缓存笔记数: ${totalNotes} 篇`, attr: { style: 'margin: 0.5rem 0;' } });


		const authContainer = containerEl.createDiv();
		this.renderAuthSection(authContainer);

		// ── 同步行为 ──
		containerEl.createEl('h3', {text: '⚡️ 同步行为'});

		new Setting(containerEl)
			.setName('启动时自动执行增量同步')
			.setDesc('每次启动 Obsidian 时，在后台静默执行一次增量同步，确保本地数据始终处于最新状态。')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncOnStartup)
				.onChange(async (value) => {
					this.plugin.settings.syncOnStartup = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('移动端自动挂起 (推荐)')
			.setDesc('在移动端启动时自动挂起插件以节省系统资源（修改后需重启 Obsidian 生效）。')
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
				.setName('附件存储策略')
				.setDesc('**下载至本地**：永久保存且支持离线查看；**在线链接**：节省空间但存在失效风险。')
				.addDropdown(dropdown => dropdown
					.addOption('local', '⬇️ 下载并保存至本地 (推荐)')
					.addOption('online', '🔗 使用云端在线链接')
					.setValue(this.plugin.settings.attachmentMode)
					.onChange(async (value: 'local' | 'online') => {
						this.plugin.settings.attachmentMode = value;
						await this.plugin.saveSettings();
						renderAttachmentSection();
					}));

			if (this.plugin.settings.attachmentMode === 'local') {
				new Setting(attachmentSection)
					.setName('附件存储路径')
					.setDesc('图片、语音等下载到本地后的媒体附件存放目录。')
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

		// ── 笔记导出模式与模板 ──
		containerEl.createEl('h3', {text: '📝 笔记导出模式与模板'});

		const templateSection = containerEl.createDiv();
		const renderTemplateSection = () => {
			templateSection.empty();
			const isIndividual = this.plugin.settings.outputMode === 'individual';

			new Setting(templateSection)
				.setName('笔记导出模式')
				.setDesc('**独立文件**：每篇笔记生成一个 .md 文件；**聚合文件**：所有笔记按顺序合并为单文件。')
				.addDropdown(dd => dd
					.addOption('individual', '📄 独立文件 (一笔记一文件)')
					.addOption('aggregate', '📚 聚合文件 (合并为单文件)')
					.setValue(this.plugin.settings.outputMode)
					.onChange(async (value: 'individual' | 'aggregate') => {
						this.plugin.settings.outputMode = value;
						await this.plugin.saveSettings();
						renderTemplateSection();
					}));

			if (isIndividual) {
				new Setting(templateSection)
					.setName('笔记存储路径')
					.setDesc('设定小米笔记同步到本地后的存储目录。')
					.addText(text => text
						.setPlaceholder('MiNotes')
						.setValue(this.plugin.settings.noteFolder)
						.onChange(async (value) => {
							this.plugin.settings.noteFolder = value;
							await this.plugin.saveSettings();
						}));

				const dateFormatSetting = new Setting(templateSection)
					.setName('时间显示格式')
					.setDesc('遵循 moment.js 规范（如 YYYY-MM-DD HH:mm）')
					.addText(text => text
						.setPlaceholder('YYYY-MM-DD_HH-mm-ss')
						.setValue(this.plugin.settings.dateFormat)
						.onChange(async (value) => {
							this.plugin.settings.dateFormat = value;
							await this.plugin.saveSettings();
							updatePreview();
						}));

				const previewEl = templateSection.createDiv({ cls: 'setting-item-description' });
				previewEl.style.fontSize = '0.85em';
				previewEl.style.color = 'var(--text-accent)';
				previewEl.style.marginTop = '-8px';
				previewEl.style.marginBottom = '12px';

				const updatePreview = () => {
					try {
						const sample = window.moment().format(this.plugin.settings.dateFormat);
						previewEl.setText(`🕒 预览：${sample}`);
					} catch (e) {
						previewEl.setText('❌ 无效的时间格式');
					}
				};
				updatePreview();

				const mockVars = {
					id: '123456',
					title: '我的小米笔记示例',
					folder: '个人',
					createTime: window.moment().format(this.plugin.settings.dateFormat),
					modifyTime: window.moment().format(this.plugin.settings.dateFormat),
					color: '1'
				};

				new Setting(templateSection)
					.setName('笔记文件名模板')
					.setDesc('设定同步到本地后的 Markdown 文件命名规则。')
					.addText(text => {
						text.setPlaceholder('{{createTime}}_{{title}}')
							.setValue(this.plugin.settings.fileNameTemplate)
							.onChange(async (value) => {
								this.plugin.settings.fileNameTemplate = value;
								await this.plugin.saveSettings();
								updateFileNamePreview();
							});
						
						this.renderVariableHelper(templateSection, text.inputEl, ['id', 'title', 'folder', 'createTime', 'modifyTime', 'color'], async (val) => {
							this.plugin.settings.fileNameTemplate = val;
							await this.plugin.saveSettings();
							updateFileNamePreview();
						});
					})
					.addExtraButton(btn => btn
						.setIcon('rotate-ccw')
						.setTooltip('恢复默认文件命名')
						.onClick(async () => {
							this.plugin.settings.fileNameTemplate = DEFAULT_SETTINGS.fileNameTemplate;
							await this.plugin.saveSettings();
							renderTemplateSection();
						}));
				const updateFileNamePreview = this.renderTemplatePreview(templateSection, () => this.plugin.settings.fileNameTemplate, mockVars);

				new Setting(templateSection)
					.setName('YAML 元数据模板 (Frontmatter)')
					.setDesc('在每篇 Markdown 笔记顶部注入的元数据属性块。支持下方定义的变量。')
					.addTextArea(text => {
						text.inputEl.rows = 6;
						text.inputEl.style.width = '100%';
						text.inputEl.style.fontFamily = 'monospace';
						text.setValue(this.plugin.settings.frontmatterTemplate)
							.onChange(async (value) => {
								this.plugin.settings.frontmatterTemplate = value;
								await this.plugin.saveSettings();
								updateYamlPreview();
							});
						
						this.renderVariableHelper(templateSection, text.inputEl, ['id', 'title', 'folder', 'createTime', 'modifyTime', 'color'], async (val) => {
							this.plugin.settings.frontmatterTemplate = val;
							await this.plugin.saveSettings();
							updateYamlPreview();
						});
					})
					.addExtraButton(btn => btn
						.setIcon('rotate-ccw')
						.setTooltip('恢复默认 YAML 模板')
						.onClick(async () => {
							this.plugin.settings.frontmatterTemplate = DEFAULT_SETTINGS.frontmatterTemplate;
							await this.plugin.saveSettings();
							renderTemplateSection();
						}));
				const updateYamlPreview = this.renderTemplatePreview(templateSection, () => this.plugin.settings.frontmatterTemplate, mockVars);
			} else {
				const dateFormatSettingAgg = new Setting(templateSection)
					.setName('时间格式')
					.setDesc('遵循 moment.js 规范（如 YYYY-MM-DD HH:mm）')
					.addText(text => text
						.setPlaceholder('YYYY-MM-DD_HH-mm-ss')
						.setValue(this.plugin.settings.dateFormat)
						.onChange(async (value) => {
							this.plugin.settings.dateFormat = value;
							await this.plugin.saveSettings();
							updatePreviewAgg();
						}));

				const previewElAgg = templateSection.createDiv({ cls: 'setting-item-description' });
				previewElAgg.style.fontSize = '0.85em';
				previewElAgg.style.color = 'var(--text-accent)';
				previewElAgg.style.marginTop = '-8px';
				previewElAgg.style.marginBottom = '12px';

				const updatePreviewAgg = () => {
					try {
						const sample = window.moment().format(this.plugin.settings.dateFormat);
						previewElAgg.setText(`🕒 预览：${sample}`);
					} catch (e) {
						previewElAgg.setText('❌ 无效的时间格式');
					}
				};
				updatePreviewAgg();

				new Setting(templateSection)
					.setName('聚合文件存储路径')
					.setDesc('指定聚合模式下所有笔记写入的目标 Markdown 文件路径（相对于知识库根目录）。')
					.addText(text => text
						.setPlaceholder('MiNotes/全量笔记.md')
						.setValue(this.plugin.settings.aggregateFilePath)
						.onChange(async (value) => {
							this.plugin.settings.aggregateFilePath = value;
							await this.plugin.saveSettings();
						}));

				const aggMockVars = {
					id: '123456',
					title: '聚合示例笔记',
					folder: '工作',
					createTime: window.moment().format(this.plugin.settings.dateFormat),
					modifyTime: window.moment().format(this.plugin.settings.dateFormat),
					color: '2',
					content: '这是在聚合文件中的分段渲染示例...'
				};

				new Setting(templateSection)
					.setName('聚合笔记渲染模板')
					.setDesc('设定每篇笔记在聚合文件中的分段渲染样式。')
					.addTextArea(text => {
						text.inputEl.rows = 7;
						text.inputEl.style.width = '100%';
						text.inputEl.style.fontFamily = 'monospace';
						text.setValue(this.plugin.settings.noteTemplate)
							.onChange(async (value) => {
								this.plugin.settings.noteTemplate = value;
								await this.plugin.saveSettings();
								updateNoteTemplatePreview();
							});

						this.renderVariableHelper(templateSection, text.inputEl, ['id', 'title', 'folder', 'createTime', 'modifyTime', 'color', 'content'], async (val) => {
							this.plugin.settings.noteTemplate = val;
							await this.plugin.saveSettings();
							updateNoteTemplatePreview();
						});
					})
					.addExtraButton(btn => btn
						.setIcon('rotate-ccw')
						.setTooltip('恢复默认聚合模板')
						.onClick(async () => {
							this.plugin.settings.noteTemplate = DEFAULT_SETTINGS.noteTemplate;
							await this.plugin.saveSettings();
							renderTemplateSection();
						}));
				const updateNoteTemplatePreview = this.renderTemplatePreview(templateSection, () => this.plugin.settings.noteTemplate, aggMockVars);
			}
		};
		renderTemplateSection();

		// ── MiNote2Daily ──
		containerEl.createEl('h3', {text: '📅 每日速记集成 (MiNote2Daily)'});
		
		const dailySectionContainer = containerEl.createDiv();
		
		const renderDailySection = () => {
			dailySectionContainer.empty();
			
			new Setting(dailySectionContainer)
				.setName('开启 MiNote2Daily 功能')
				.setDesc('支持将今日新增的小米笔记自动分发并追加到您的每日日记文件中。')
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.dailySyncEnabled)
					.onChange(async (value) => {
						this.plugin.settings.dailySyncEnabled = value;
						await this.plugin.saveSettings();
						renderDailySection();
					}));

			if (this.plugin.settings.dailySyncEnabled) {
				new Setting(dailySectionContainer)
					.setName('随主同步流程自动触发 (推送到日记)')
					.setDesc('开启后，每次执行主同步（包括启动自动同步）时，会自动将昨日/今日更新的笔记同步至日记。')
					.addToggle(toggle => toggle
						.setValue(this.plugin.settings.dailySyncAuto)
						.onChange(async (value) => {
							this.plugin.settings.dailySyncAuto = value;
							await this.plugin.saveSettings();
						}));

				new Setting(dailySectionContainer)
					.setName('内容插入逻辑')
					.setDesc('**追加**：在日记末尾插入；**标题**：在指定标题下方插入；**光标**：在编辑器当前光标处插入。')
					.addDropdown(dd => dd
						.addOption('append', '⬇️ 追加到末尾')
						.addOption('heading', '📌 指定标题下方')
						.addOption('cursor', '🖱️ 插入至当前光标处')
						.setValue(this.plugin.settings.dailySyncMethod)
						.onChange(async (value: 'append' | 'heading' | 'cursor') => {
							this.plugin.settings.dailySyncMethod = value;
							await this.plugin.saveSettings();
							renderDailySection();
						}));

				if (this.plugin.settings.dailySyncMethod === 'heading') {
					new Setting(dailySectionContainer)
						.setName('目标 H2/H3 标题')
						.setDesc('插件将在此标题（如 `## 小米笔记`）下方插入内容。若标题不存在则会自动创建。')
						.addText(text => text
							.setPlaceholder('## 小米笔记')
							.setValue(this.plugin.settings.dailySyncHeading)
							.onChange(async (value) => {
								this.plugin.settings.dailySyncHeading = value;
								await this.plugin.saveSettings();
							}));
				}

				new Setting(dailySectionContainer)
					.setName('同步时间窗口 (小时)')
					.setDesc('仅拉取指定时间范围内（过去 N 小时）修改过的笔记，防止将历史笔记意外刷入日记中。默认 24 小时。')
					.addText(text => text
						.setPlaceholder('24')
						.setValue((this.plugin.settings.dailySyncLookbackHours ?? 24).toString())
						.onChange(async (value) => {
							const num = Number(value);
							if (!isNaN(num) && num > 0) {
								this.plugin.settings.dailySyncLookbackHours = num;
								await this.plugin.saveSettings();
							}
						}));

				const dailyMockVars = {
					time: window.moment().format('HH:mm:ss'),
					title: '今日小米速记',
					folder: '随笔',
					content: '这是同步到日记中的示例内容...'
				};

				new Setting(dailySectionContainer)
					.setName('日记内容渲染模板')
					.setDesc('设定单条速记同步到日记时的显示样式。支持下方特有的时间变量。')
					.addTextArea(text => {
						text.inputEl.rows = 4;
						text.inputEl.style.width = '100%';
						text.inputEl.style.fontFamily = 'monospace';
						text.setValue(this.plugin.settings.dailyNoteTemplate)
							.onChange(async (value) => {
								this.plugin.settings.dailyNoteTemplate = value;
								await this.plugin.saveSettings();
								updateDailyPreview();
							});
						
						this.renderVariableHelper(dailySectionContainer, text.inputEl, ['time', 'title', 'folder', 'content'], async (val) => {
							this.plugin.settings.dailyNoteTemplate = val;
							await this.plugin.saveSettings();
							updateDailyPreview();
						});
					})
					.addExtraButton(btn => btn
						.setIcon('rotate-ccw')
						.setTooltip('恢复默认日记模板')
						.onClick(async () => {
							this.plugin.settings.dailyNoteTemplate = DEFAULT_SETTINGS.dailyNoteTemplate;
							await this.plugin.saveSettings();
							renderDailySection();
						}));
				const updateDailyPreview = this.renderTemplatePreview(dailySectionContainer, () => this.plugin.settings.dailyNoteTemplate, dailyMockVars);
			}
		};
		renderDailySection();

		// ── 维护与危险操作 ──
		containerEl.createEl('h3', {text: '🛡️ 维护与危险操作'});

		new Setting(containerEl)
			.setName('重构本地索引并全量同步')
			.setDesc('丢弃本地同步状态，强制重新从云端全量拉取所有笔记及其分类。建议在数据损坏或云端大规模重组后使用。')
			.addButton(btn => btn
				.setButtonText('立即执行重构同步')
				.setWarning()
				.onClick(async () => {
					if (this.plugin.isSyncing) {
						new Notice('⚠️ 同步任务正在运行中，请等待当前任务完成。');
						return;
					}
					
					btn.setDisabled(true);
					btn.setButtonText('初始化索引...');
					this.plugin.isSyncing = true;
					this.plugin.statusBarItem.setText('⏳ 正在重构索引并执行全量同步...');
					
					try {
						this.plugin.settings.syncState = { lastSyncTime: 0, syncTag: '', notes: {}, folders: {} };
						await this.plugin.saveSettings();
					
						const engine = this.plugin.createSyncEngine((msg: string) => {
							this.plugin.statusBarItem.setText(msg);
						});
						await engine.runSync();
						btn.setButtonText('已完成');
					} finally {
						this.plugin.isSyncing = false;
						setTimeout(() => {
							btn.setDisabled(false);
							btn.setButtonText('立即全量同步');
						}, 3000);
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

	private renderTemplatePreview(containerEl: HTMLElement, getTemplate: () => string, variables: Record<string, string>) {
		const previewContainer = containerEl.createDiv();
		previewContainer.style.marginTop = '4px';
		previewContainer.style.marginBottom = '12px';
		previewContainer.style.padding = '8px 12px';
		previewContainer.style.borderRadius = '4px';
		previewContainer.style.backgroundColor = 'var(--background-secondary)';
		previewContainer.style.border = '1px solid var(--background-modifier-border)';
		previewContainer.style.fontSize = '0.85em';
		previewContainer.style.fontFamily = 'monospace';
		previewContainer.style.whiteSpace = 'pre-wrap';
		previewContainer.style.color = 'var(--text-muted)';

		const updatePreview = () => {
			let result = getTemplate();
			for (const key in variables) {
				result = result.replace(new RegExp(`{{${key}}}`, 'g'), variables[key]);
			}
			previewContainer.setText(`👀 预览结果：\n${result}`);
		};

		updatePreview();
		return updatePreview;
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
				? '✅ 登录状态有效。已通过安全离线沙盒成功校验会话，您可以开始同步。' 
				: '❌ 当前未登录。请点击下方按钮通过安全离线沙盒完成扫码或密码鉴权。您可随时一键重置沙盒以确保隐私安全。');

		if (isLogin) {
			loginDesc.addButton(btn => btn
				.setButtonText('清除会话并粉碎数据')
				.setWarning()
				.onClick(async () => {
					btn.setDisabled(true);
					btn.setButtonText('正在粉碎数据...');
					
					// Partition 轮转架构：直接分配一个新的隔离区，抛弃存在 Cookie 缓存的旧区
					this.plugin.settings.partition = 'persist:minotesync_' + Date.now();
					await this.plugin.saveSettings();
					
					// 干掉后台挂载的含有旧登录态的实例
					destroyProxyWebview();

					new Notice('✅ 已成功清除会话并粉碎数据。本地缓存已彻底销毁，再次同步需重新授权。', 5000);
					this.renderAuthSection(container);
				}));
		} else {
			loginDesc.addButton(btn => btn
				.setButtonText('立即前往授权')
				.setCta()
				.onClick(() => {
					new XiaomiLoginModal(this.app, this.plugin.settings.partition, () => {
						new Notice('🎉 小米云服务鉴权成功！您可以开始同步笔记。');
						this.renderAuthSection(container); 
					}).open();
				}));
		}
	}
}
