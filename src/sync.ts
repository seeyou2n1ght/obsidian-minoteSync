import { App, Notice, TFile, TFolder, MarkdownView, Editor } from 'obsidian';
import { MiNoteAPI, NoteEntry } from './api';
import { note2markdown, sanitizePath, formatDateTime } from './utils';

export interface SyncState {
	lastSyncTime: number;
	syncTag: string;
	notes: Record<string, { id: string, modifyDate: number, path: string }>;
	folders: Record<string, string>;
}

export class SyncEngine {
	app: App;
	api: MiNoteAPI;
	noteFolder: string;
	attachmentFolder: string;
	attachmentMode: 'local' | 'online';
	state: SyncState;
	saveState: (state: SyncState) => Promise<void>;
	onProgress: (msg: string) => void;
	partition: string;
	fileNameTemplate: string;
	frontmatterTemplate: string;
	dateFormat: string;
	outputMode: 'individual' | 'aggregate';
	aggregateFilePath: string;
	noteTemplate: string;
	dailySyncAuto: boolean;
	dailySyncMethod: 'append' | 'cursor' | 'heading';
	dailySyncHeading: string;
	dailyNoteTemplate: string;

	constructor(
		app: App,
		partition: string,
		noteFolder: string,
		attachmentFolder: string,
		attachmentMode: 'local' | 'online',
		state: SyncState,
		saveState: (state: SyncState) => Promise<void>,
		onProgress: (msg: string) => void = () => {},
		fileNameTemplate: string = '{{createTime}}_{{title}}',
		frontmatterTemplate: string = 'mi-note-id: {{id}}\nmi-note-folder: {{folder}}\ncreated: {{createTime}}\nmodified: {{modifyTime}}',
		dateFormat: string = 'YYYY-MM-DD_HH-mm-ss',
		outputMode: 'individual' | 'aggregate' = 'individual',
		aggregateFilePath: string = 'MiNotes/全量笔记.md',
		noteTemplate: string = '## {{title}}\n> 📁 {{folder}}  |  🕐 {{createTime}}\n\n{{content}}\n\n---',
		dailySyncAuto: boolean = false,
		dailySyncMethod: 'append' | 'cursor' | 'heading' = 'append',
		dailySyncHeading: string = '',
		dailyNoteTemplate: string = ''
	) {
		this.app = app;
		this.partition = partition;
		this.api = new MiNoteAPI(partition);
		this.noteFolder = noteFolder;
		this.attachmentFolder = attachmentFolder;
		this.attachmentMode = attachmentMode;
		this.state = state;
		this.saveState = saveState;
		this.onProgress = onProgress;
		this.fileNameTemplate = fileNameTemplate;
		this.frontmatterTemplate = frontmatterTemplate;
		this.dateFormat = dateFormat;
		this.outputMode = outputMode;
		this.aggregateFilePath = aggregateFilePath;
		this.noteTemplate = noteTemplate;
		this.dailySyncAuto = dailySyncAuto;
		this.dailySyncMethod = dailySyncMethod;
		this.dailySyncHeading = dailySyncHeading;
		this.dailyNoteTemplate = dailyNoteTemplate;
	}

	private renderTemplate(template: string, vars: Record<string, string>): string {
		let result = template;
		for (const key in vars) {
			result = result.replace(new RegExp(`{{${key}}}`, 'g'), vars[key]);
		}
		return result;
	}

	/**
	 * 聚合模式：将单篇笔记以 ID 锚点分段插入或替换到聚合文件中
	 * 锚点格式：<!-- mi-note-id: {id} --> ... <!-- /mi-note-id -->
	 */
	private async upsertAggregateNote(noteId: string, segment: string): Promise<void> {
		const filePath = this.aggregateFilePath;

		// 确保目录存在
		const dir = filePath.substring(0, filePath.lastIndexOf('/'));
		if (dir) await this.ensureFolder(dir);

		const anchor = `<!-- mi-note-id: ${noteId} -->`;
		const closeAnchor = `<!-- /mi-note-id -->`;
		const wrappedSegment = `${anchor}\n${segment}\n${closeAnchor}\n`;

		const existingFile = this.app.vault.getAbstractFileByPath(filePath);

		if (!(existingFile instanceof TFile)) {
			// 文件不存在，直接创建
			await this.app.vault.create(filePath, wrappedSegment);
			return;
		}

		let content = await this.app.vault.read(existingFile);
		const startIdx = content.indexOf(anchor);

		if (startIdx === -1) {
			// 该笔记锚点不存在，在文件末尾追加
			const sep = content.endsWith('\n') ? '' : '\n';
			content = content + sep + wrappedSegment;
		} else {
			// 定位到 closeAnchor 的末尾，实现精准替换
			const endIdx = content.indexOf(closeAnchor, startIdx);
			if (endIdx === -1) {
				// 未找到闭合锚点（文件损坏），直接截断并替换从 anchor 开始到末尾
				content = content.substring(0, startIdx) + wrappedSegment;
			} else {
				const afterEnd = endIdx + closeAnchor.length;
				// 保留闭合后的换行符
				const tail = content.substring(afterEnd).startsWith('\n')
					? content.substring(afterEnd)
					: '\n' + content.substring(afterEnd);
				content = content.substring(0, startIdx) + wrappedSegment + tail.trimStart();
			}
		}

		await this.app.vault.modify(existingFile, content);
	}

	async ensureFolder(path: string) {
		const parts = path.split('/').filter(p => p.length > 0);
		let current = '';
		for (const part of parts) {
			current = current === '' ? part : `${current}/${part}`;
			const abstractFile = this.app.vault.getAbstractFileByPath(current);
			if (!abstractFile) {
				await this.app.vault.createFolder(current);
			}
		}
	}

	async runSync() {
		try {
			new Notice('小米笔记：正在唤醒云端接口...');
			const isLogin = await MiNoteAPI.checkLoginStatus(this.partition);
			if (!isLogin) {
				new Notice('检测到未登录或会话过期，请先在插件设置中完成扫码授权！');
				return;
			}
			new Notice('小米笔记：授权通过，开始校验同步状态...', 2000);
			await this.ensureFolder(this.noteFolder);
			await this.ensureFolder(this.attachmentFolder);

			let entries: NoteEntry[] = [];
			let folders: Record<string, string> = { "0": "未分类" };
			let currentSyncTag: string | undefined = this.state.syncTag;

			// 分页拉取数据
			while (true) {
				const res = await this.api.getNoteList(currentSyncTag, 200);
				entries = [...entries, ...res.data.entries];
				for (const f of res.data.folders) {
					folders[f.id] = sanitizePath(f.subject);
				}
				currentSyncTag = res.data.syncTag;
				if (res.data.lastPage) break;
			}

			// 更新文件夹映射状态
			this.state.folders = folders;

			const toSync: NoteEntry[] = [];
			for (const entry of entries) {
				const existing = this.state.notes[entry.id];
				let needsSync = false;

				if (!existing || existing.modifyDate < entry.modifyDate) {
					needsSync = true;
				} else if (existing.path && !this.app.vault.getAbstractFileByPath(existing.path)) {
					// 兼容场景：本地被用户手动误删了文件，这种情况下也要拉回来
					needsSync = true;
				}

				if (needsSync) {
					toSync.push(entry);
				}
			}

			if (toSync.length === 0) {
				new Notice('小米笔记：已经是最新，没有需要同步的笔记');
				this.state.syncTag = currentSyncTag || '';
				await this.saveState(this.state);
				return;
			}

			new Notice(`小米笔记：发现 ${toSync.length} 篇有更新，开始下载...`);

			let synced = 0;
			let failedEntries: string[] = [];
			for (const entry of toSync) {
				try {
					this.onProgress(`⏳ 拉取并解析笔记中... (${synced + 1}/${toSync.length})`);
					const detailRes = await this.api.getNoteDetail(entry.id);
					const noteDetail = detailRes.data.entry;
					
					// 提取 extraInfo (JSON 字符串)
					let extraInfo: any = {};
					if (noteDetail.extraInfo) {
						try {
							extraInfo = JSON.parse(noteDetail.extraInfo);
						} catch(e) {}
					}

					let content = noteDetail.content || noteDetail.snippet || "";
					if (extraInfo.mind_content) content = extraInfo.mind_content;

					// 检测是否为小米端到端加密内容 (ARES 开头即为 AES 加密特征，常见于私密便签/开启了安全云服务的账号)
					if (content.startsWith('ARES') && content.length > 30 && !content.includes(' ') && !content.includes('<')) {
						content = "> [!warning] 端到端加密笔记\n> 这篇笔记已被小米云服务的**端到端加密**保护。\n> 您的加密密钥仅存储在本地设备中，未上传至云端，因而在第三方环境中无法直接解密呈现。\n> \n> **💡 建议：** 请您在小米手机端或网页端解除该篇笔记的私密状态，或关闭整个账号的端到端加密，然后再次点击同步。";
					}

					let subject = extraInfo.title || content.split('\n')[0].substring(0, 10).trim() || '未命名';
					subject = sanitizePath(subject);

					const folderName = folders[noteDetail.folderId] || '未分类';
					const targetNoteDir = `${this.noteFolder}/${folderName}`;
					await this.ensureFolder(targetNoteDir);

					// 处理附件
					const files: any[] = [];
					if (noteDetail.setting && noteDetail.setting.data) {
						for (const fileMeta of noteDetail.setting.data) {
							const mimeParts = fileMeta.mimeType?.split('/') || ['image', 'jpeg'];
							const type = mimeParts[0];
							const suffix = mimeParts[1];
							const id = fileMeta.fileId.split('.')[1] || fileMeta.fileId;
							const cleanSubject = sanitizePath(subject);
							const filename = `${type}_${cleanSubject}_${id}.${suffix}`;
							files.push({ rawId: fileMeta.fileId, name: filename });

							if (this.attachmentMode === 'local') {
								// 下载附件
								const attachPath = `${this.attachmentFolder}/${filename}`;
								if (!this.app.vault.getAbstractFileByPath(attachPath)) {
									const buffer = await this.api.downloadAttachment(fileMeta.fileId);
									await this.app.vault.createBinary(attachPath, buffer);
								}
							}
						}
					}

					const markdownBody = note2markdown(content, files, this.attachmentMode);
					
					// -------------- 模板引擎插值逻辑 --------------
						// 构建可用变量表
								const vars: Record<string, string> = {
									id: noteDetail.id,
									folder: folderName,
									title: subject,
									createTime: window.moment(noteDetail.createDate).format(this.dateFormat),
									modifyTime: window.moment(noteDetail.modifyDate).format(this.dateFormat),
									color: String(noteDetail.colorId || '')
								};

								if (this.outputMode === 'aggregate') {
									// ── 聚合模式：渲染段落模板并以 ID 锚点分段写入聚合文件 ──
									const aggVars = { ...vars, content: markdownBody };
									const segment = this.renderTemplate(this.noteTemplate, aggVars);
									await this.upsertAggregateNote(noteDetail.id, segment);
									this.state.notes[noteDetail.id] = {
										id: noteDetail.id,
										modifyDate: noteDetail.modifyDate,
										path: this.aggregateFilePath
									};
								} else {
									// ── 分文件模式：YAML Frontmatter + 独立文件落地 ──
									let yamlBody = this.renderTemplate(this.frontmatterTemplate, vars).trim();
									let finalContent = markdownBody;
									if (yamlBody) {
										if (!yamlBody.startsWith('---')) {
											yamlBody = '---\n' + yamlBody + '\n---';
										}
										finalContent = yamlBody + '\n\n' + markdownBody;
									}

									let rawFileName = sanitizePath(this.renderTemplate(this.fileNameTemplate, vars).trim());
									rawFileName = rawFileName.replace(/\.md$/i, '');
									let fileName = rawFileName + '.md';
									let filePath = `${targetNoteDir}/${fileName}`;

									const existingRecord = this.state.notes[noteDetail.id];
									let counter = 1;
									let possibleConflict = this.app.vault.getAbstractFileByPath(filePath);
									while (possibleConflict instanceof TFile && (!existingRecord || existingRecord.path !== filePath)) {
										fileName = `${rawFileName}_${counter}.md`;
										filePath = `${targetNoteDir}/${fileName}`;
										possibleConflict = this.app.vault.getAbstractFileByPath(filePath);
										counter++;
									}

									if (existingRecord && existingRecord.path !== filePath) {
										const oldFile = this.app.vault.getAbstractFileByPath(existingRecord.path);
										if (oldFile instanceof TFile) await this.app.vault.trash(oldFile, true);
									}

									const existingAbstract = this.app.vault.getAbstractFileByPath(filePath);
									if (existingAbstract instanceof TFile) {
										await this.app.vault.modify(existingAbstract, finalContent);
									} else {
										await this.app.vault.create(filePath, finalContent);
									}

									this.state.notes[noteDetail.id] = {
										id: noteDetail.id,
										modifyDate: noteDetail.modifyDate,
										path: filePath
									};
								}
								synced++;

							} catch(err) {
								failedEntries.push(entry.id);
								console.error('⚠️ 笔记下载解析失败', entry.id, err);
							}
			}

			this.state.syncTag = currentSyncTag || '';
			this.state.lastSyncTime = Date.now();
			await this.saveState(this.state);
			
			this.onProgress(`✅ 同步完成 (${synced}/${toSync.length})`);
			if (failedEntries.length > 0) {
				new Notice(`小米笔记：部分同步完成 (${synced}/${toSync.length})，有 ${failedEntries.length} 篇遇到了异常错误未落地，请打开开发者工具 (Ctrl+Shift+I) 查看明细原因。`, 10000);
			} else {
				new Notice(`小米笔记：同步完成！成功更新 ${synced} 篇笔记。`);
			}

			// ── 自动同步至日记 ──
			if (this.dailySyncAuto) {
				await this.syncToDailyNote(this.dailySyncMethod, this.dailySyncHeading, this.dailyNoteTemplate);
			}
		} catch (error) {
			console.error(error);
			new Notice(`小米笔记同步失败: ${error.message}`);
		}
	}

	/**
	 * 获取今日日记文件对象
	 */
	private async getDailyNoteFile(): Promise<TFile | null> {
		// 尝试从每日笔记插件配置中获取目录和格式
		const dailyNotesSetting = (this.app as any).internalPlugins?.getPluginById('daily-notes')?.instance?.options;
		const folder = dailyNotesSetting?.folder || '';
		const format = dailyNotesSetting?.format || 'YYYY-MM-DD';
		
		const fileName = window.moment().format(format) + '.md';
		const path = folder ? `${folder}/${fileName}` : fileName;
		
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) return file;
		
		// 如果不存在，尝试直接在根目录或指定目录创建
		if (folder) await this.ensureFolder(folder);
		return await this.app.vault.create(path, '');
	}

	/**
	 * 将当日更新的小米笔记同步至日记
	 */
	async syncToDailyNote(method: 'append' | 'cursor' | 'heading', heading?: string, template: string = '') {
		try {
			const isLogin = await MiNoteAPI.checkLoginStatus(this.partition);
			if (!isLogin) {
				new Notice('❌ 请先在配置页完成小米云登录授权');
				return;
			}

			this.onProgress('🔍 筛选今日笔记中...');
			const res = await this.api.getNoteList(undefined, 100);
			const todayStr = window.moment().format('YYYY-MM-DD');
			const todayNotes = res.data.entries.filter(e => {
				const mDate = window.moment(e.modifyDate).format('YYYY-MM-DD');
				return mDate === todayStr;
			});

			if (todayNotes.length === 0) {
				new Notice('📅 今日暂无更新的小米笔记');
				return;
			}

			new Notice(`🚀 正在同步 ${todayNotes.length} 篇今日笔记...`);

			let combinedContent = '\n';
			for (const entry of todayNotes) {
				const detailRes = await this.api.getNoteDetail(entry.id);
				const noteDetail = detailRes.data.entry;
				
				// 复用部分解析逻辑
				let extraInfo: any = {};
				if (noteDetail.extraInfo) {
					try { extraInfo = JSON.parse(noteDetail.extraInfo); } catch(e) {}
				}
				let rawContent = noteDetail.content || noteDetail.snippet || "";
				if (extraInfo.mind_content) rawContent = extraInfo.mind_content;
				
				// 如果是加密内容，简单处理
				if (rawContent.startsWith('ARES') && rawContent.length > 30) {
					rawContent = "*[加密笔记，请在手机端解密后同步]*";
				}

				let subject = extraInfo.title || rawContent.split('\n')[0].substring(0, 15).trim() || '未命名';
				subject = sanitizePath(subject);

				const vars: Record<string, string> = {
					id: noteDetail.id,
					title: subject,
					folder: this.state.folders[noteDetail.folderId] || '未分类',
					content: note2markdown(rawContent, [], 'online'), // 日记中默认使用在线链接简化逻辑
					time: window.moment(noteDetail.modifyDate).format('HH:mm:ss')
				};

				combinedContent += this.renderTemplate(template, vars) + '\n';
			}

			// 执行插入逻辑
			if (method === 'cursor') {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView) {
					activeView.editor.replaceSelection(combinedContent);
					new Notice('✅ 已插入至光标位置');
				} else {
					new Notice('❌ 插入失败：未发现处于焦点的编辑器');
				}
				return;
			}

			const dailyFile = await this.getDailyNoteFile();
			if (!dailyFile) return;

			let fileContent = await this.app.vault.read(dailyFile);
			
			if (method === 'append') {
				fileContent = fileContent.trimEnd() + '\n' + combinedContent;
			} else if (method === 'heading' && heading) {
				const headingRegex = new RegExp(`(^${heading}\\s*$)`, 'm');
				if (headingRegex.test(fileContent)) {
					fileContent = fileContent.replace(headingRegex, `$1\n${combinedContent.trim()}\n`);
				} else {
					// 找不到标题，退回到追加并提示
					fileContent = fileContent.trimEnd() + `\n\n${heading}\n` + combinedContent;
					new Notice(`⚠️ 未找到标题 "${heading}"，已自动补全并追加`);
				}
			}

			await this.app.vault.modify(dailyFile, fileContent);
			new Notice(`✅ 成功同步 ${todayNotes.length} 篇笔记至日记`);

		} catch (error) {
			console.error(error);
			new Notice(`MiNote2Daily 失败: ${error.message}`);
		}
	}
}
