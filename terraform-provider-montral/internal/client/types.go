package client

// Wire types of the Montral management API. Fields the provider does not manage are left out; unknown fields in an
// answer are ignored by encoding/json.

// Mask is the placeholder Montral returns instead of a stored credential to callers that may not read it.
const Mask = "••••••••"

// Monitor mirrors apps/api/src/routes/monitors.ts (create body and returned row).
type Monitor struct {
	ID                   string            `json:"id,omitempty"`
	ProjectID            *string           `json:"projectId,omitempty"`
	Name                 string            `json:"name"`
	Type                 string            `json:"type,omitempty"`
	Target               string            `json:"target"`
	Method               string            `json:"method"`
	RequestBody          *string           `json:"requestBody"`
	DomainExpiryWarnDays int64             `json:"domainExpiryWarnDays"`
	ExpectedStatus       int64             `json:"expectedStatus"`
	IntervalSec          int64             `json:"intervalSec"`
	TimeoutMs            int64             `json:"timeoutMs"`
	FailureThreshold     int64             `json:"failureThreshold"`
	RecoveryThreshold    int64             `json:"recoveryThreshold"`
	Regions              []string          `json:"regions"`
	Keyword              *string           `json:"keyword"`
	KeywordMode          string            `json:"keywordMode"`
	JSONPath             *string           `json:"jsonPath"`
	JSONExpected         *string           `json:"jsonExpected"`
	JSONMatch            string            `json:"jsonMatch"`
	ExpectedLocation     *string           `json:"expectedLocation"`
	Headers              map[string]string `json:"headers"`
	WSMessage            *string           `json:"wsMessage"`
	DNSRecordType        string            `json:"dnsRecordType"`
	DNSExpectedValue     *string           `json:"dnsExpectedValue"`
	DNSMatchMode         string            `json:"dnsMatchMode"`
	GraceSec             int64             `json:"graceSec"`
	ChannelIDs           []string          `json:"channelIds"`
	Tags                 []string          `json:"tags"`
	SlowThresholdMs      int64             `json:"slowThresholdMs"`
	SlowAlertAfter       int64             `json:"slowAlertAfter"`
	DependsOnMonitorID   *string           `json:"dependsOnMonitorId"`
	MinRegionsFailing    int64             `json:"minRegionsFailing"`
	EscalationPolicyID   *string           `json:"escalationPolicyId"`
	// PATCH only
	Paused *bool `json:"paused,omitempty"`

	// read only
	Status         string  `json:"status,omitempty"`
	HeartbeatToken *string `json:"heartbeatToken,omitempty"`
	CreatedAt      string  `json:"createdAt,omitempty"`
}

// Channel mirrors apps/api/src/routes/channels.ts.
type Channel struct {
	ID         string         `json:"id,omitempty"`
	ProjectID  *string        `json:"projectId,omitempty"`
	Type       string         `json:"type,omitempty"`
	Name       string         `json:"name"`
	Config     map[string]any `json:"config"`
	Enabled    bool           `json:"enabled"`
	AutoEnable bool           `json:"autoEnable"`
	Scope      string         `json:"scope,omitempty"` // create only
	CreatedAt  string         `json:"createdAt,omitempty"`
}

// StatusPageComponent is one ordered entry of a status page.
type StatusPageComponent struct {
	MonitorID string  `json:"monitorId"`
	GroupName *string `json:"groupName,omitempty"`
}

// StatusPage mirrors apps/api/src/routes/status.ts (management API).
type StatusPage struct {
	ID                       string                `json:"id"`
	ProjectID                *string               `json:"projectId"`
	Slug                     string                `json:"slug"`
	Title                    string                `json:"title"`
	Theme                    string                `json:"theme"`
	ShowLatency              bool                  `json:"showLatency"`
	ExternalURL              *string               `json:"externalUrl"`
	HideBranding             bool                  `json:"hideBranding"`
	UptimeOkPct              float64               `json:"uptimeOkPct"`
	UptimeWarnPct            float64               `json:"uptimeWarnPct"`
	MCPEnabled               bool                  `json:"mcpEnabled"`
	Visibility               string                `json:"visibility"`
	HasPassword              bool                  `json:"hasPassword"`
	MaintenanceReminderHours int64                 `json:"maintenanceReminderHours"`
	Components               []StatusPageComponent `json:"components"`
	CreatedAt                string                `json:"createdAt"`
}

// StatusPageWrite is the create/patch body. Pointers leave a field unchanged on PATCH.
type StatusPageWrite struct {
	Slug                     string                `json:"slug,omitempty"`
	Title                    string                `json:"title"`
	Theme                    string                `json:"theme,omitempty"`
	ShowLatency              *bool                 `json:"showLatency,omitempty"`
	ExternalURL              *string               `json:"externalUrl"`
	HideBranding             *bool                 `json:"hideBranding,omitempty"`
	UptimeOkPct              *float64              `json:"uptimeOkPct,omitempty"`
	UptimeWarnPct            *float64              `json:"uptimeWarnPct,omitempty"`
	MCPEnabled               *bool                 `json:"mcpEnabled,omitempty"`
	Visibility               string                `json:"visibility,omitempty"`
	Password                 string                `json:"password,omitempty"`
	MaintenanceReminderHours *int64                `json:"maintenanceReminderHours,omitempty"`
	Components               []StatusPageComponent `json:"components"`
}

// MaintenanceRecurrence is a bounded daily or weekly series.
type MaintenanceRecurrence struct {
	Frequency string `json:"frequency"`
	TimeZone  string `json:"timeZone"`
	Until     string `json:"until"`
}

// MaintenanceWindow mirrors apps/api/src/routes/maintenance.ts.
type MaintenanceWindow struct {
	ID         string                 `json:"id,omitempty"`
	ProjectID  *string                `json:"projectId,omitempty"`
	SeriesID   *string                `json:"seriesId,omitempty"`
	Name       string                 `json:"name"`
	StartsAt   string                 `json:"startsAt"`
	EndsAt     string                 `json:"endsAt"`
	MonitorIDs []string               `json:"monitorIds"`
	Recurrence *MaintenanceRecurrence `json:"recurrence"`
}

// Project mirrors GET /api/projects.
type Project struct {
	ID             string `json:"id"`
	OrganizationID string `json:"organizationId"`
	Name           string `json:"name"`
	CreatedAt      string `json:"createdAt"`
}

// EscalationStep is one escalation level of a project.
type EscalationStep struct {
	ChannelIDs       []string `json:"channelIds"`
	EscalateAfterMin int64    `json:"escalateAfterMin"`
}

// ProjectAlerting mirrors GET/PUT /api/projects/:id/alerting.
type ProjectAlerting struct {
	ReminderIntervalMin *int64           `json:"reminderIntervalMin"`
	ReminderEmail       bool             `json:"reminderEmail"`
	Escalation          []EscalationStep `json:"escalation"`
}
