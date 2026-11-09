package provider

import (
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
)

// Per-type channel settings, mirroring CONFIG in apps/api/src/routes/channels.ts. The API drops settings it does not
// know, so an unknown key is refused here (it would otherwise vanish after apply).
type channelKeys struct {
	plain    []string
	secret   []string
	required []string
}

var channelTypes = map[string]channelKeys{
	"email":      {plain: []string{"to"}, required: []string{"to"}},
	"slack":      {secret: []string{"url"}, required: []string{"url"}},
	"discord":    {secret: []string{"url"}, required: []string{"url"}},
	"teams":      {secret: []string{"url"}, required: []string{"url"}},
	"webhook":    {secret: []string{"url"}, required: []string{"url"}},
	"googlechat": {secret: []string{"url"}, required: []string{"url"}},
	"mattermost": {secret: []string{"url"}, required: []string{"url"}},
	"ntfy":       {plain: []string{"priority"}, secret: []string{"url", "topic", "token"}, required: []string{"url", "topic"}},
	"gotify":     {secret: []string{"url", "token"}, required: []string{"url", "token"}},
	"pushover":   {plain: []string{"device"}, secret: []string{"token", "userKey"}, required: []string{"token", "userKey"}},
	"lark":       {secret: []string{"url", "secret"}, required: []string{"url"}},
	"telegram":   {plain: []string{"chatId"}, secret: []string{"botToken"}, required: []string{"botToken", "chatId"}},
	"pagerduty":  {secret: []string{"routingKey"}, required: []string{"routingKey"}},
	"push":       {},
}

func channelTypeNames() []string {
	out := make([]string, 0, len(channelTypes))
	for k := range channelTypes {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

var (
	emailRE        = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)
	ntfyTopicRE    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	pushoverKeyRE  = regexp.MustCompile(`^[A-Za-z0-9]{30}$`)
	pushoverDevRE  = regexp.MustCompile(`^[A-Za-z0-9_-]{1,25}(,[A-Za-z0-9_-]{1,25})*$`)
	mattermostRE   = regexp.MustCompile(`/hooks/[A-Za-z0-9]+$`)
	googleChatPath = regexp.MustCompile(`^/v1/spaces/[^/]+/messages$`)
)

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// channelProblems judges plain (`config`) and secret (`secret_config`) settings. A nil map is not known yet.
func channelProblems(channelType string, plain, secret map[string]string) []problem {
	keys, ok := channelTypes[channelType]
	if !ok {
		return nil // the type validator reports it
	}
	var out []problem
	add := func(a, m string) { out = append(out, problem{a, m}) }
	if plain != nil {
		for _, k := range sortedKeys(plain) {
			switch {
			case contains(keys.secret, k):
				add("config", fmt.Sprintf("%q is a credential for Montral; set it in secret_config instead of config", k))
			case !contains(keys.plain, k):
				add("config", fmt.Sprintf("%s channels have no setting %q (allowed in config: %s)", channelType, k, listOrNone(keys.plain)))
			}
		}
	}
	if secret != nil {
		for _, k := range sortedKeys(secret) {
			switch {
			case contains(keys.plain, k):
				add("secret_config", fmt.Sprintf("%q is not a credential; set it in config instead of secret_config", k))
			case !contains(keys.secret, k):
				add("secret_config", fmt.Sprintf("%s channels have no secret setting %q (allowed in secret_config: %s)", channelType, k, listOrNone(keys.secret)))
			}
		}
	}
	if plain == nil || secret == nil {
		return out // required keys and cross-field rules need both maps
	}
	all := map[string]string{}
	for k, v := range plain {
		all[k] = v
	}
	for k, v := range secret {
		all[k] = v
	}
	for _, k := range keys.required {
		if _, ok := all[k]; !ok {
			attr := "config"
			if contains(keys.secret, k) {
				attr = "secret_config"
			}
			add(attr, fmt.Sprintf("%s channels need %q", channelType, k))
		}
	}
	for _, k := range sortedKeys(all) {
		v := all[k]
		attr := "config"
		if contains(keys.secret, k) {
			attr = "secret_config"
		}
		if v == "" || strings.TrimSpace(v) != v {
			add(attr, fmt.Sprintf("%q must be non-empty without surrounding spaces (omit optional settings instead of leaving them empty)", k))
			continue
		}
		if msg := channelValueProblem(channelType, k, v, all); msg != "" {
			add(attr, msg)
		}
	}
	return out
}

func channelValueProblem(channelType, key, v string, all map[string]string) string {
	if key == "url" {
		u, err := url.Parse(v)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || len(v) > 2000 {
			return "url must be an http(s) URL of at most 2000 characters"
		}
		switch channelType {
		case "ntfy":
			if (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
				return "ntfy url must be the server origin, without a topic, query or credentials"
			}
		case "googlechat":
			q := u.Query()
			if u.Scheme != "https" || u.Host != "chat.googleapis.com" || !googleChatPath.MatchString(u.Path) || !q.Has("key") || !q.Has("token") {
				return "use the webhook URL Google Chat gives you (https://chat.googleapis.com/v1/spaces/.../messages?key=...&token=...)"
			}
		case "mattermost":
			if !mattermostRE.MatchString(u.Path) || u.User != nil || u.Fragment != "" {
				return "use the Mattermost incoming webhook URL (https://<server>/hooks/<id>)"
			}
		case "gotify":
			if u.Scheme != "https" {
				return "a Gotify application token is only sent to an https:// server"
			}
			if u.RawQuery != "" || u.User != nil || strings.HasSuffix(strings.TrimRight(u.Path, "/"), "/message") {
				return "use the Gotify server URL without /message, a query or credentials"
			}
		}
		return ""
	}
	switch channelType + "." + key {
	case "email.to":
		if len(v) > 254 || !emailRE.MatchString(v) {
			return "to must be an email address"
		}
	case "ntfy.topic":
		if !ntfyTopicRE.MatchString(v) {
			return "topic must be 1-64 letters, digits, underscores or hyphens"
		}
	case "ntfy.priority":
		if !contains([]string{"1", "2", "3", "4", "5"}, v) {
			return `priority must be "1" to "5"`
		}
	case "ntfy.token":
		if !strings.HasPrefix(strings.ToLower(all["url"]), "https://") {
			return "an access token is only sent to an https:// server"
		}
	case "pushover.token", "pushover.userKey":
		if !pushoverKeyRE.MatchString(v) {
			return key + " must be 30 letters and digits"
		}
	case "pushover.device":
		if !pushoverDevRE.MatchString(v) || len(v) > 200 {
			return "device must be comma-separated device names (letters, digits, _ or -)"
		}
	case "telegram.botToken", "pagerduty.routingKey", "gotify.token", "lark.secret":
		if len(v) > 200 {
			return key + " must be at most 200 characters"
		}
	case "telegram.chatId":
		if len(v) > 100 {
			return "chatId must be at most 100 characters"
		}
	}
	return ""
}

func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func listOrNone(l []string) string {
	if len(l) == 0 {
		return "none"
	}
	return strings.Join(l, ", ")
}
