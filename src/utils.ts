import { NoteEntry, NoteFolder } from './api';

export function sanitizePath(filename: string): string {
	return filename
		.replace(/[/\\?%*:|"<>]/g, "_")
		.replace(/\s+/g, "_")
		.replace(/_{2,}/g, "_")
		.toLowerCase();
}

export function formatDateTime(timestamp: number): string {
	const date = new Date(timestamp);
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	const seconds = String(date.getSeconds()).padStart(2, "0");
	return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
}

export function note2markdown(content: string, files: any[] = [], attachmentMode: 'local' | 'online' = 'local'): string {
	let markdown = content || "";

	// 1. 去掉 <new-format/> 标签
	markdown = markdown.replace(/<new-format\s*\/>/g, "");

	// 2. 处理分割线
	markdown = markdown.replace(/<hr\s*\/>/g, "---");

	// 3. 处理引用块
	markdown = markdown.replace(/<quote>(.*?)<\/quote>/gs, "> $1");

	// 4. 处理文本样式标签
	markdown = markdown.replace(/<b>(.*?)<\/b>/g, "**$1**");
	markdown = markdown.replace(/<i>(.*?)<\/i>/g, "*$1*");
	markdown = markdown.replace(/<u>(.*?)<\/u>/g, "<u>$1</u>");
	markdown = markdown.replace(/<delete>(.*?)<\/delete>/g, "~~$1~~");

	// 5. 对齐标签
	markdown = markdown.replace(/<center>(.*?)<\/center>/g, "<center>$1</center>");
	markdown = markdown.replace(/<left>(.*?)<\/left>/g, '<div align="left">$1</div>');
	markdown = markdown.replace(/<right>(.*?)<\/right>/g, '<div align="right">$1</div>');

	// 6. 背景色
	markdown = markdown.replace(
		/<background color="([^"]+)">(.*?)<\/background>/g,
		(_, color, content) => {
			if (color.length === 9) { // #AARRGGBB -> #RRGGBBAA or similar. MiNote uses # + 8 hex. 
				color = `#${color.slice(3)}${color.slice(1, 3)}`;
			}
			return `<span style="background-color: ${color};">${content}</span>`;
		}
	);

	// 7. 处理字体大小标签
	markdown = markdown.replace(/<size>(.*?)<\/size>/g, "# $1");
	markdown = markdown.replace(/<mid-size>(.*?)<\/mid-size>/g, "## $1");
	markdown = markdown.replace(/<h3-size>(.*?)<\/h3-size>/g, "### $1");

	// 8. 列表
	// 有序列表：使用 inputNumber 属性生成正确的序号编号
	markdown = markdown.replace(/<order indent="(\d+)" inputNumber="(\d+)" \/>/g, (_, indentStr, numStr) => {
		const indentCount = parseInt(indentStr, 10) - 1;
		return "  ".repeat(Math.max(0, indentCount)) + `${numStr}. `;
	});

	markdown = markdown.replace(/<bullet indent="(\d+)" \/>/g, (_, indentStr) => {
		const indentCount = parseInt(indentStr, 10) - 1;
		return "  ".repeat(Math.max(0, indentCount)) + "- ";
	});

	// 9. 复选框
	markdown = markdown.replace(
		/<input type="checkbox" indent="(\d+)" level="\d+"(?: checked="true")? \/>/g,
		(match, indentStr) => {
			const indentCount = parseInt(indentStr, 10) - 1;
			const spaces = "  ".repeat(Math.max(0, indentCount));
			const checked = match.includes('checked="true"') ? "x" : " ";
			return `${spaces}- [${checked}] `;
		}
	);

	markdown = markdown.replaceAll('<input type="checkbox" checked="true" />', "- [x] ");
	markdown = markdown.replaceAll('<input type="checkbox" />', "- [ ] ");

	// 10. 文件替换占位符
	for (const file of files) {
		const fileId = file.fileId || file.rawId;
		const name = file.name || `${fileId}.jpg`; 
		
		let replacement = `![[${name}]]`;

		if (attachmentMode === 'online') {
			const isAudioOrVideo = name.startsWith('audio_') || name.startsWith('sound_') || name.startsWith('video_');
			const link = `https://i.mi.com/file/full?fileid=${encodeURIComponent(fileId)}&type=note_img`;
			// 只有图片使用 ![]() 嵌入，不确认 Obsidian 能否直链播放带 Cookie 验证的视频音频，不过统一使用链接让用户能点
			replacement = isAudioOrVideo ? `[${name}](${link})` : `![](${link})`;
		}
		
		markdown = markdown.replace(new RegExp(`<img fileid="${fileId}"[^>]*>`, "g"), replacement);
		markdown = markdown.replace(new RegExp(`<sound fileid="${fileId}"[^>]*>`, "g"), replacement);
		markdown = markdown.replace(new RegExp(`<video fileid="${fileId}"[^>]*>`, "g"), replacement);
		markdown = markdown.replace(new RegExp(`☺ ${fileId}`, "g"), replacement);
	}

	// 11. text 标签缩进
	markdown = markdown.replace(
		/<text indent="(\d+)">(.*?)<\/text>/gs,
		(_, indentStr, content) => {
			const indentCount = parseInt(indentStr, 10) - 1;
			return "  ".repeat(Math.max(0, indentCount)) + content;
		}
	);

	// 12. 整理换行
	markdown = markdown.replaceAll("\n", "\n\n");
	markdown = markdown.replace(/- (.*?)\n\n- /g, "- $1\n- ");
	markdown = markdown.replace(/\n{3,}/g, "\n\n");

	return markdown.trim();
}
