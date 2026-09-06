// Package gt implements the candidate translation command using an injected AI service.
package gt

import (
	"context"
	"errors"
	"strings"
	"unicode"
)

type Provider func(context.Context, string, string) (string, error)

// Message operations use Telegram HTML. Text must be the dispatcher's normalized
// command text, not the original transport message when an alias was expanded.
type Message interface {
	ReplyText(context.Context) (string, error)
	EditHTML(context.Context, string) error
	ReplyHTML(context.Context, string) error
}

const Help = `📘 <b>AI 翻译</b>

• <code>gt [文本]</code> - 翻译为简体中文
• <code>gt en [文本]</code> - 翻译为英文
• 回复消息后使用 <code>gt</code> 或 <code>gt en</code>
• <code>gt help</code> - 查看帮助

使用 ai 插件当前聊天 API、模型及超时设置。
请先安装配套 ai 插件，并通过 <code>ai config add</code> 和 <code>ai model chat</code> 配置。
待翻译文本会发送至该 API，可能产生模型调用费用。`

const failed = "❌ AI 翻译失败，请检查 ai 聊天配置、API 可用性及超时设置后重试"

// Handle is scoped to a generation/request context. Cancellation suppresses
// late output; the caller must track the task until the provider returns.
func Handle(ctx context.Context, text string, msg Message, provider Provider) error {
	err := translate(ctx, text, msg, provider)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err != nil {
		return msg.EditHTML(ctx, failed)
	}
	return nil
}

func translate(ctx context.Context, text string, msg Message, provider Provider) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	text = stripToken(text)
	first := strings.ToLower(firstToken(text))
	if first == "h" || first == "help" {
		return msg.EditHTML(ctx, Help)
	}
	target := "zh-CN"
	if first == "en" {
		target = "en"
		text = stripToken(text)
	}
	if strings.TrimFunc(text, space) == "" {
		var err error
		text, err = msg.ReplyText(ctx)
		if err != nil {
			return err
		}
	}
	if strings.TrimFunc(text, space) == "" {
		return msg.EditHTML(ctx, "❌ 请提供要翻译的文本或回复一条文字消息")
	}
	if units(text) > 5000 {
		return msg.EditHTML(ctx, "❌ 文本过长，请保持在5000字符以内")
	}
	if provider == nil {
		return msg.EditHTML(ctx, "❌ 请先安装或更新配套 ai 插件，并配置 ai model chat")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := msg.EditHTML(ctx, "🔄 <b>AI 翻译中...</b>"); err != nil {
		return err
	}
	translated, err := provider(ctx, text, target)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimFunc(translated, space) == "" {
		return errors.New("empty translation")
	}
	var chunks []string
	start, length := 0, 0
	for offset, r := range translated {
		n := 1
		if r > 0xffff {
			n = 2
		}
		if length+n > 3000 {
			chunks = append(chunks, translated[start:offset])
			start = offset
			length = 0
		}
		length += n
	}
	chunks = append(chunks, translated[start:])
	language := "中文"
	if target == "en" {
		language = "英文"
	}
	previewRunes := []rune(text)
	if len(previewRunes) > 50 {
		previewRunes = previewRunes[:50]
	}
	preview := string(previewRunes)
	suffix := ""
	if units(preview) < units(text) {
		suffix = "..."
	}
	if err := msg.EditHTML(ctx, "🌐 <b>AI 翻译结果</b> (→ "+language+")\n\n<b>原文:</b>\n<code>"+escape(preview)+suffix+"</code>\n\n<b>译文:</b>\n"+escape(chunks[0])); err != nil {
		return err
	}
	for _, chunk := range chunks[1:] {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := msg.ReplyHTML(ctx, escape(chunk)); err != nil {
			return err
		}
	}
	return nil
}

func space(r rune) bool {
	return r == '\ufeff' || r == '\t' || r == '\n' || r == '\v' || r == '\f' || r == '\r' || r == '\u2028' || r == '\u2029' || unicode.Is(unicode.Zs, r)
}
func firstToken(s string) string {
	for i, r := range s {
		if space(r) {
			return s[:i]
		}
	}
	return s
}
func stripToken(s string) string {
	token := firstToken(s)
	if token == "" {
		return s
	}
	return strings.TrimLeftFunc(s[len(token):], space)
}
func units(s string) int {
	n := 0
	for _, r := range s {
		n++
		if r > 0xffff {
			n++
		}
	}
	return n
}

var htmlEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;", "'", "&#x27;")

func escape(s string) string { return htmlEscaper.Replace(s) }
