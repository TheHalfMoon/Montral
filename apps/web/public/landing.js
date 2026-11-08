/* ---------- i18n ---------- */
// English lives in the HTML itself; it is captured once and used as the fallback.
var T={
'zh-CN':{
 title:'Montral — 开源网站监控、可用性监控与状态页',
 desc:'开源的网站监控与可用性监控（Uptime），不按监控项收费。支持 HTTP、TCP、DNS 和心跳检测，宕机时通过 Slack、飞书 / Lark、Telegram、邮件告警，自带公开状态页。',
 'nav.features':'功能',
 'inc.1':'排查中','inc.2':'已定位原因','inc.3':'已恢复','hero.tag':'开源','hero.agents':'为 Agent 而生','mcp.eyebrow':'MCP','mcp.title':'让 AI Agent 替你管监控','mcp.lead':'Montral 自带 MCP 服务。接入 Claude、Cursor 或任意 MCP 客户端，用自然语言就能操作。','mcp.s1t':'接入客户端','mcp.s1d':'在支持远程服务的 MCP 客户端里，添加你的 Montral 地址加上 /api/mcp。','mcp.s2t':'用 OAuth 授权','mcp.s2d':'登录后选择 Agent 能访问的范围：所有工作区、选定的工作区，或只有选定的项目。可随时撤销。','mcp.s3t':'直接提需求','mcp.s3d':'创建监控、暂停、立即检测、创建和更新事件。在你允许的范围内，Agent 还能创建项目和工作区。','mcp.cta':'阅读 MCP 文档 →',
 'hero.h1a':'价格实惠的可用性监控，','hero.h1b':'交给 AI Agent 来管。',
 'hero.lead':'检测、告警、状态页，用 Claude、Cursor 或任意 MCP 客户端就能管理。开源，没有按监控项收费。',
 'nav.signin':'登录','nav.app':'进入控制台','hero.cta1':'立即试用','hero.cta2':'查看在线演示','copy':'复制','copied':'已复制',
 'hero.note':'开源（MIT）。软件本身不收集遥测数据。',
 'toast.t':'无法访问','toast.d':'连续 3 次检测失败','toast.time':'刚刚',
 'dash.ok':'所有系统运行正常','dash.uptime':'近 30 天可用率','dash.resp':'平均响应时间','dash.regions':'组件数','dash.ago':'90 天前','dash.today':'今天','dash.sample':'以上为示例数据。',
 'int.t':'告警与自动化，接入你现有的工具','fl.t':'Montral 支持的全部功能','fl.g1':'监控','fl.g1i1':'HTTP / HTTPS 检测','fl.g1i2':'TCP 端口、DNS、PostgreSQL、MySQL、Redis','fl.g1i3':'心跳监控，适用于定时任务和后台进程','fl.g1i4':'关键词出现或缺失、预期状态码、自定义方法与请求头','fl.g1i5':'响应过慢阈值告警','fl.g1i6':'最短每分钟检测一次，可设置连续失败阈值','fl.g1i7':'暂停与恢复，支持 JSON 导入导出','fl.g2':'故障事件','fl.g2i1':'故障自动创建、自动恢复','fl.g2i2':'可手动创建故障并发布进展，从排查中到已恢复','fl.g2i3':'确认故障，并记录处理人','fl.g2i4':'计划维护窗口，期间不发告警','fl.g2i5':'发送失败的告警会自动重试，并保留完整告警日志','fl.g3':'告警渠道','fl.g3i1':'Slack、飞书、Telegram、PagerDuty、邮件、Webhook','fl.g3i2':'每个监控项可单独选择告警渠道','fl.g4':'状态页','fl.g4i1':'分组组件，90 天历史','fl.g4i2':'故障时间线与邮件订阅','fl.g4i3':'浅色、深色或自动主题，可选显示响应时间','fl.g4i4':'RSS 订阅、SVG 状态徽章、可嵌入的状态摘要','fl.g4i5':'页眉可选添加指向自己网站的链接','fl.g5':'自动化','fl.g5i1':'应用能做的，REST API 都能做','fl.g5i2':'API 密钥，可用于脚本、Terraform 和 CI','fl.g5i3':'MCP 服务，OAuth 授权，可限定到工作区或项目','fl.g6':'团队与账号','fl.g6i1':'工作区与项目，含所有者、管理员、成员角色','fl.g6i2':'邮件邀请、GitHub 登录、两步验证','fl.g6i3':'中英文界面，账号数据导出','fl.g6i4':'可自托管于 Cloudflare Workers 与 Postgres，MIT 许可',
 'mon.api':'接口','mon.web':'网站','mon.db':'数据库','mon.pay':'支付回调',
 'st.op':'运行正常','st.deg':'性能下降',
 'why.eyebrow':'痛点','why.title':'现有方案，总要你让步一点','why.lead':'多数团队的要求并不高：告警靠谱、状态页拿得出手、不被厂商绑定。',
 'why.p1t':'监控的账单涨得比业务还快','why.p1d':'SaaS 监控按监控项、检测频率、席位和状态页分别计费。服务一多，监控本身就成了一笔不小的开销。',
 'why.p2t':'监控和服务一起挂','why.p2d':'自建监控常和被监控的服务跑在同一套设施上，机器或网络一出问题，告警也跟着哑火。',
 'why.p3t':'想自动化，却没有 API','why.p3d':'每上线一个新服务，就得去后台手动配一遍。没有完整的 API，Terraform 和 CI 都接不进来。',
 'feat.eyebrow':'核心能力','feat.title':'监控、告警、状态页，一个项目全搞定','feat.lead':'开源，MIT 许可。可以部署在 Cloudflare，也可以用一个 Docker 容器运行。',
 'feat.f1t':'不只是看状态码','feat.f1d':'支持 HTTP、TCP、DNS 和心跳检测，最短 1 分钟一次。还能校验响应里是否包含（或不包含）某个关键字，而不只是看 200。',
 'feat.f2t':'故障过程自动记录','feat.f2d':'连续失败后自动创建事件。你把进展从“排查中”更新到“已恢复”，订阅者每一步都会收到邮件。',
 'feat.f3t':'拿得出手的状态页','feat.f3d':'组件分组展示，附带 90 天历史、事件时间线和邮件订阅。',
 'feat.f4t':'告警直达常用渠道','feat.f4d':'支持 Slack、飞书 / Lark、Telegram、PagerDuty、邮件和 Webhook，每个监控都能单独指定通知渠道。',
 'feat.f5t':'API 优先','feat.f5d':'界面上能做的，API 都能做。用 API 密钥就能创建监控、告警渠道和状态页。',
 'cmp.eyebrow':'横向对比','cmp.title':'他们为什么换过来','cmp.c1':'SaaS 托管服务','cmp.c2':'常见自建方案',
 'cmp.r1':'不用维护服务器','cmp.r2':'自带公开状态页','cmp.r3':'完整的 REST API','cmp.r4':'数据在自己手里','cmp.r5':'可免费自托管','cmp.r6':'内置 MCP 服务，AI Agent 直接可用',
 'open.eyebrow':'公开开发','open.title':'代码、路线图和讨论，全部公开','open.lead':'监控工具得在你最糟糕的那天依然可靠，所以每个决定，都在你看得见的地方做出。',
 'open.f1':'协议，商用、修改和再分发都不受限制。','open.f2':'软件自带的遥测。不会向任何地方回传数据；页面统计需要你自己开启。','open.f3b':'免费','open.f3':'自托管。用你自己的 Cloudflare 账号和 Postgres 即可。',
 'ba.eyebrow':'换一种早晨','ba.title':'从“被用户告知”，到“自己先知道”',
 'ba.before':'以前','ba.after':'用上 Montral 之后',
 'ba.b1':'凌晨 2 点被客户的消息吵醒，才知道服务挂了','ba.b2':'状态页靠手动更新，经常忘','ba.b3':'自建监控和服务器一起宕机，什么都发不出来','ba.b4':'月底账单到了，才知道监控花了多少',
 'ba.a1':'一达到失败阈值，Slack 立刻提醒','ba.a2':'状态页自动切换，并附带时间线','ba.a3':'监控即代码，跟着服务一起上线','ba.a4':'一个 Worker 加你自己的 Postgres，成本自己说了算',
 'fin.title':'服务器挂了，监控不会挂','fin.lead':'部署在你自己的 Cloudflare 账号里。用着不合适？删掉 Worker，不会留下任何东西。','fin.cta1':'立即试用','fin.cta2':'阅读文档',
 'ft.tag':'面向 Cloudflare Workers 与 Postgres 的开源可用性监控与状态页。','ft.alt':'替代方案对比','ft.for':'使用场景','ft.ios':'iOS 应用','ft.product':'产品','ft.selfhost':'自托管','ft.status':'服务状态','ft.embed':'嵌入状态','ft.changelog':'更新日志','ft.dev':'开发者','ft.docs':'文档','ft.api':'API 参考','ft.contrib':'贡献指南','ft.comm':'社区','ft.sec':'安全披露','ft.priv':'隐私','ft.terms':'服务条款','ft.legal':'© 2026 Montral 贡献者 · MIT 许可证','ft.built':'公开开发。'
},
ja:{
 title:'Montral — 手頃な価格のUptime監視とステータスページ',
 desc:'モニター数による課金のない、オープンソースのUptime監視。HTTP・TCP・DNS・ハートビート監視、Slack・Lark・Telegram・メール通知、公開ステータスページに対応します。',
 'nav.features':'機能',
 'inc.1':'調査中','inc.2':'原因特定','inc.3':'解決済み','hero.tag':'オープンソース','hero.agents':'エージェント対応','mcp.eyebrow':'MCP','mcp.title':'監視の運用をAIエージェントに任せる','mcp.lead':'MontralにはMCPサーバーが付属しています。ClaudeやCursorなどのMCPクライアントをつなぎ、普通の言葉で頼めます。','mcp.s1t':'クライアントを接続','mcp.s1d':'リモートサーバーに対応したMCPクライアントに、Montralのアドレスと /api/mcp を追加します。','mcp.s2t':'OAuthで承認','mcp.s2d':'ログインして、エージェントが触れる範囲（すべてのワークスペース、選んだワークスペース、選んだプロジェクトのみ）を選びます。いつでも取り消せます。','mcp.s3t':'やりたいことを頼む','mcp.s3d':'モニターの作成・一時停止、即時チェック、インシデントの作成と更新。許可した範囲ではプロジェクトやワークスペースの作成もできます。','mcp.cta':'MCPガイドを読む →',
 'hero.h1a':'手頃な価格のUptime監視、','hero.h1b':'AIエージェントに任せられる。',
 'hero.lead':'監視もアラートもステータスページも、ClaudeやCursor、任意のMCPクライアントから操作できます。オープンソースで、モニター数による課金はありません。',
 'nav.signin':'ログイン','nav.app':'ダッシュボード','hero.cta1':'今すぐ試す','hero.cta2':'ライブデモを見る','copy':'コピー','copied':'コピー済み',
 'hero.note':'オープンソース（MIT）。ソフトウェア自体はテレメトリを送信しません。',
 'toast.t':'がダウン中','toast.d':'3回連続でチェックに失敗','toast.time':'たった今',
 'dash.ok':'全システム正常稼働中','dash.uptime':'30日間の稼働率','dash.resp':'平均応答時間','dash.regions':'コンポーネント','dash.ago':'90日前','dash.today':'今日','dash.sample':'表示はサンプルデータです。',
 'int.t':'アラートと自動化を、既存のスタックに','fl.t':'Montral が対応するすべての機能','fl.g1':'監視','fl.g1i1':'HTTP / HTTPS チェック','fl.g1i2':'TCP ポート、DNS、PostgreSQL、MySQL、Redis','fl.g1i3':'cron ジョブやワーカー向けのハートビート監視','fl.g1i4':'キーワードの有無、期待ステータス、メソッドとヘッダーの指定','fl.g1i5':'応答遅延のしきい値アラート','fl.g1i6':'最短 1 分間隔、連続失敗しきい値の設定','fl.g1i7':'一時停止と再開、JSON のインポート／エクスポート','fl.g2':'インシデント','fl.g2i1':'インシデントを自動で作成・解決','fl.g2i2':'手動のインシデントと進捗更新（調査中から解決まで）','fl.g2i3':'インシデントを確認し、対応者を記録','fl.g2i4':'アラートを止める計画メンテナンス枠','fl.g2i5':'送信に失敗したアラートは再試行され、履歴も保存','fl.g3':'アラート通知先','fl.g3i1':'Slack、Lark、Telegram、PagerDuty、メール、Webhook','fl.g3i2':'監視ごとに通知先を選択','fl.g4':'ステータスページ','fl.g4i1':'グループ化されたコンポーネントと 90 日間の履歴','fl.g4i2':'インシデントのタイムラインとメール購読','fl.g4i3':'ライト／ダーク／自動テーマ、応答時間の表示は任意','fl.g4i4':'RSS フィード、SVG ステータスバッジ、埋め込み用サマリー','fl.g4i5':'ヘッダーに自社サイトへのリンクを任意で追加','fl.g5':'自動化','fl.g5i1':'アプリの操作はすべて REST API から','fl.g5i2':'スクリプト、Terraform、CI 向けの API キー','fl.g5i3':'OAuth 対応の MCP サーバー。ワークスペースやプロジェクト単位で範囲指定','fl.g6':'チームとアカウント','fl.g6i1':'ワークスペースとプロジェクト。オーナー・管理者・メンバーの権限','fl.g6i2':'メール招待、GitHub ログイン、2 段階認証','fl.g6i3':'英語・中国語の UI、アカウントデータのエクスポート','fl.g6i4':'Cloudflare Workers と Postgres でセルフホスト可能、MIT ライセンス',
 'mon.api':'API','mon.web':'ウェブサイト','mon.db':'データベース','mon.pay':'決済Webhook',
 'st.op':'正常稼働','st.deg':'性能低下',
 'why.eyebrow':'現状','why.title':'どの選択肢にも、どこかに妥協がある','why.lead':'多くのチームが求めるのはシンプルです。信頼できるアラート、顧客に見せられるステータスページ、そしてベンダーロックインのなさ。',
 'why.p1t':'事業より速く膨らむ請求','why.p1d':'SaaSの監視ツールは、監視数・チェック間隔・席数・ステータスページごとに課金されます。サービスが増えるほど、監視自体が大きなコストになります。',
 'why.p2t':'監視がサーバーと運命を共にする','why.p2d':'セルフホスト型は、監視対象と同じインフラの上で動きます。そのマシンやネットワークが不調なら、アラートも一緒に止まります。',
 'why.p3t':'自動化したいのにAPIがない','why.p3d':'新しいサービスのたびに、手作業で監視を追加。完全なAPIがなければ、TerraformやCIに組み込めません。',
 'feat.eyebrow':'得られるもの','feat.title':'監視、アラート、ステータスページを、ひとつに','feat.lead':'オープンソース（MIT）。Cloudflare 上でも、Docker コンテナ 1 つでも動かせます。',
 'feat.f1t':'ステータスコードだけで終わらない','feat.f1d':'HTTP・TCP・DNS・ハートビートを最短1分間隔で。キーワード（またはその不在）での検証にも対応し、200 OKだけに頼りません。',
 'feat.f2t':'状況を自ら説明するインシデント','feat.f2d':'連続失敗で自動的にインシデントを作成。調査中から解決済みまでの更新が、購読者へメールで届きます。',
 'feat.f3t':'信頼されるステータスページ','feat.f3d':'コンポーネントのグループ表示、90日間の履歴、インシデントのタイムライン、メール購読。',
 'feat.f4t':'いつもの場所にアラートを','feat.f4d':'Slack・Lark・Telegram・PagerDuty・メール・Webhook。監視ごとに通知先を選べます。',
 'feat.f5t':'APIファーストの設計','feat.f5d':'画面でできることは、すべてAPIからも可能。APIキーで監視・通知先・ステータスページを作成できます。',
 'cmp.eyebrow':'比較','cmp.title':'チームが乗り換える理由','cmp.c1':'ホスト型SaaS','cmp.c2':'一般的なセルフホスト',
 'cmp.r1':'サーバー運用が不要','cmp.r2':'公開ステータスページを標準搭載','cmp.r3':'完全なREST API','cmp.r4':'データは手元に残る','cmp.r5':'セルフホストは無料','cmp.r6':'AIエージェント向けMCPサーバーを内蔵',
 'open.eyebrow':'オープンに開発','open.title':'コードもロードマップも議論も、すべて公開','open.lead':'監視ツールは、最悪の日にこそ信頼できなければなりません。だから、あらゆる判断を見える場所で行います。',
 'open.f1':'ライセンス。商用利用、改変、再配布が自由です。','open.f2':'ソフトウェアに組み込まれたテレメトリ。外部への送信はありません。ページ解析は有効にした場合のみ動作します。','open.f3b':'無料','open.f3':'でセルフホストできます。ご自身の Cloudflare アカウントと Postgres をお使いください。',
 'ba.eyebrow':'朝の景色が変わる','ba.title':'「知らされる」から「先に知る」へ',
 'ba.before':'これまで','ba.after':'Montralなら',
 'ba.b1':'深夜2時、顧客からの連絡で初めて障害に気づく','ba.b2':'ステータスページは手動更新で、更新されないことも','ba.b3':'自前の監視がサーバーごと落ちて、障害に気づけない','ba.b4':'月末の請求を見て、初めて監視のコストを知る',
 'ba.a1':'失敗のしきい値に達した瞬間にSlackが鳴る','ba.a2':'ステータスページが自動で切り替わり、時系列も残る','ba.a3':'監視をコードで管理し、サービスと一緒にリリース','ba.a4':'WorkerとPostgresだけ。コストは自分で決められる',
 'fin.title':'サーバーが落ちても、監視は落ちない','fin.lead':'自分のCloudflareアカウントにデプロイ。合わなければWorkerを削除するだけ。何も残りません。','fin.cta1':'今すぐ試す','fin.cta2':'ドキュメントを読む',
 'ft.tag':'Cloudflare WorkersとPostgres向けの、オープンソースのUptime監視とステータスページ。','ft.alt':'代替ツールとの比較','ft.for':'ユースケース','ft.ios':'iOS アプリ','ft.product':'プロダクト','ft.selfhost':'セルフホスト','ft.status':'システム状況','ft.embed':'ステータスを埋め込む','ft.changelog':'更新履歴','ft.dev':'開発者','ft.docs':'ドキュメント','ft.api':'APIリファレンス','ft.contrib':'コントリビュート','ft.comm':'コミュニティ','ft.sec':'セキュリティ','ft.priv':'プライバシー','ft.terms':'利用規約','ft.legal':'© 2026 Montral contributors · MITライセンス','ft.built':'オープンに開発中。'
},
es:{
 title:'Montral — Monitorización de uptime asequible y páginas de estado',
 desc:'Monitorización de uptime de código abierto, sin tarifas por monitor. Comprobaciones HTTP, TCP, DNS y heartbeat, alertas por Slack, Lark, Telegram y correo, y páginas de estado públicas.',
 'nav.features':'Funciones',
 'inc.1':'Investigando','inc.2':'Identificado','inc.3':'Resuelto','hero.tag':'Código abierto','hero.agents':'Pensado para agentes','mcp.eyebrow':'MCP','mcp.title':'Deja que tu agente de IA gestione la monitorización','mcp.lead':'Montral incluye un servidor MCP. Conecta Claude, Cursor o cualquier cliente MCP y pídelo con tus palabras.','mcp.s1t':'Conecta tu cliente','mcp.s1d':'Añade la dirección de tu Montral con /api/mcp en cualquier cliente MCP que admita servidores remotos.','mcp.s2t':'Autoriza con OAuth','mcp.s2d':'Inicia sesión y elige a qué puede acceder el agente: todos los espacios, los seleccionados o solo proyectos concretos. Puedes revocarlo cuando quieras.','mcp.s3t':'Pide lo que necesites','mcp.s3d':'Crea y pausa monitores, ejecuta comprobaciones, abre y actualiza incidentes. Donde lo permitas, también crea proyectos y espacios.','mcp.cta':'Leer la guía de MCP →',
 'hero.h1a':'Monitorización de uptime asequible','hero.h1b':'que tu agente de IA puede gestionar.',
 'hero.lead':'Comprobaciones, alertas y páginas de estado que gestionas desde Claude, Cursor o cualquier cliente MCP. Código abierto, sin tarifas por monitor.',
 'nav.signin':'Iniciar sesión','nav.app':'Panel','hero.cta1':'Pruébalo ahora','hero.cta2':'Ver demo en vivo','copy':'Copiar','copied':'Copiado',
 'hero.note':'Código abierto (MIT). El software no envía telemetría.',
 'toast.t':'está caído','toast.d':'Tras 3 comprobaciones fallidas seguidas','toast.time':'ahora mismo',
 'dash.ok':'Todos los sistemas operativos','dash.uptime':'Uptime a 30 días','dash.resp':'Respuesta media','dash.regions':'Componentes','dash.ago':'Hace 90 días','dash.today':'Hoy','dash.sample':'Datos de ejemplo, solo ilustrativos.',
 'int.t':'ALERTAS Y AUTOMATIZACIÓN QUE ENCAJAN EN TU STACK','fl.t':'TODO LO QUE MONTRAL SOPORTA','fl.g1':'Monitorización','fl.g1i1':'Comprobaciones HTTP y HTTPS','fl.g1i2':'Puerto TCP, DNS, PostgreSQL, MySQL y Redis','fl.g1i3':'Monitores heartbeat para cron y workers','fl.g1i4':'Palabra clave presente o ausente, estado esperado, método y cabeceras propios','fl.g1i5':'Alertas por umbral de respuesta lenta','fl.g1i6':'Comprobaciones cada minuto como mínimo, con umbral de fallos','fl.g1i7':'Pausa y reanudación, importación y exportación JSON','fl.g2':'Incidentes','fl.g2i1':'Los incidentes se abren y se resuelven solos','fl.g2i2':'Incidentes manuales con actualizaciones, de «investigando» a «resuelto»','fl.g2i3':'Reconocer incidentes, con registro de quién responde','fl.g2i4':'Ventanas de mantenimiento programado que silencian las alertas','fl.g2i5':'Los envíos fallidos se reintentan; registro completo de alertas','fl.g3':'Canales de alerta','fl.g3i1':'Slack, Lark, Telegram, PagerDuty, correo y webhooks','fl.g3i2':'Elige qué canales avisa cada monitor','fl.g4':'Páginas de estado','fl.g4i1':'Componentes agrupados con historial de 90 días','fl.g4i2':'Cronología de incidentes y suscriptores por correo','fl.g4i3':'Tema claro, oscuro o automático; tiempos de respuesta opcionales','fl.g4i4':'Feed RSS, insignia SVG de estado y resumen incrustable','fl.g4i5':'Enlace opcional a tu sitio web en la cabecera','fl.g5':'Automatización','fl.g5i1':'API REST para todo lo que hace la aplicación','fl.g5i2':'Claves de API para scripts, Terraform y CI','fl.g5i3':'Servidor MCP con OAuth, limitado a espacios de trabajo o proyectos','fl.g6':'Equipos y cuenta','fl.g6i1':'Espacios de trabajo y proyectos, con roles de propietario, administrador y miembro','fl.g6i2':'Invitaciones por correo, acceso con GitHub y verificación en dos pasos','fl.g6i3':'Aplicación en inglés y chino, exportación de datos de la cuenta','fl.g6i4':'Autoalojable en Cloudflare Workers y Postgres, licencia MIT',
 'mon.api':'API','mon.web':'Sitio web','mon.db':'Base de datos','mon.pay':'Webhook de pagos',
 'st.op':'Operativo','st.deg':'Degradado',
 'why.eyebrow':'El statu quo','why.title':'Cada opción te obliga a ceder en algo','why.lead':'Lo que la mayoría de los equipos quiere es sencillo: alertas fiables, una página de estado que dé gusto enseñar y ningún vendor lock-in.',
 'why.p1t':'Facturas que crecen más rápido que tú','why.p1d':'Los monitores SaaS cobran por monitor, intervalo, usuario y página de estado. Con cada servicio nuevo, la monitorización se vuelve una partida propia.',
 'why.p2t':'Un monitor que corre la misma suerte que tus servidores','why.p2d':'Las herramientas autoalojadas viven en la misma infraestructura que vigilan. Cuando esa máquina o esa red falla, las alertas caen con ella.',
 'why.p3t':'Automatizar sin una API','why.p3d':'Servicio nuevo, monitor nuevo, más clics. Sin una API completa no puedes integrar la monitorización en Terraform ni en CI.',
 'feat.eyebrow':'Qué incluye','feat.title':'Monitorización, alertas y páginas de estado en un solo paquete','feat.lead':'Código abierto con licencia MIT. Ejecútalo en Cloudflare o en un único contenedor Docker.',
 'feat.f1t':'Comprobaciones que van más allá del código de estado','feat.f1d':'HTTP, TCP, DNS y heartbeats cada minuto. Valida una palabra clave —o su ausencia—, no solo un 200 OK.',
 'feat.f2t':'Incidentes que se explican solos','feat.f2d':'Los incidentes se abren solos tras fallos consecutivos. Publica actualizaciones de «investigando» a «resuelto» y tus suscriptores reciben un correo.',
 'feat.f3t':'Páginas de estado que inspiran confianza','feat.f3d':'Componentes agrupados, historial de 90 días, cronología de incidentes y suscriptores por correo.',
 'feat.f4t':'Alertas donde ya estás','feat.f4d':'Slack, Lark, Telegram, PagerDuty, correo y webhooks. Elige a qué canales avisa cada monitor.',
 'feat.f5t':'API primero, por diseño','feat.f5d':'Todo lo que hace la interfaz, lo hace la API. Crea monitores, canales y páginas de estado con claves de API.',
 'cmp.eyebrow':'Cara a cara','cmp.title':'Por qué los equipos se cambian','cmp.c1':'SaaS alojado','cmp.c2':'Autoalojado típico',
 'cmp.r1':'Sin servidores que mantener','cmp.r2':'Páginas de estado públicas incluidas','cmp.r3':'API REST completa','cmp.r4':'Tus datos se quedan contigo','cmp.r5':'Gratis para autoalojar','cmp.r6':'Servidor MCP integrado para agentes de IA',
 'open.eyebrow':'Construido en abierto','open.title':'Código, hoja de ruta y debates, todo público','open.lead':'Una herramienta de monitorización tiene que merecer confianza en tu peor día. Por eso cada decisión se toma a la vista.',
 'open.f1':'Licencia que permite uso comercial, modificación y redistribución.','open.f2':'Telemetría en el software. No se envía nada; las analíticas de página solo si las activas.','open.f3b':'Gratis','open.f3':'para autoalojar. Usa tu propia cuenta de Cloudflare y Postgres.',
 'ba.eyebrow':'Otra mañana','ba.title':'De que te avisen los usuarios a enterarte tú primero',
 'ba.before':'Antes','ba.after':'Con Montral',
 'ba.b1':'Te enteras a las 2 de la madrugada porque un cliente te escribe','ba.b2':'La página de estado se actualiza a mano, si es que se actualiza','ba.b3':'Tu monitor autoalojado cae junto con el servidor donde corre','ba.b4':'La factura de monitorización llega a fin de mes',
 'ba.a1':'Slack se enciende en cuanto se alcanza el umbral de fallos','ba.a2':'La página de estado cambia sola, con su cronología','ba.a3':'Monitores como código, desplegados junto al servicio','ba.a4':'Workers más un Postgres tuyo. Tú decides cuánto cuesta.',
 'fin.title':'Monitorización que sigue en pie cuando tus servidores caen','fin.lead':'Despliégalo en tu cuenta de Cloudflare. ¿No te convence? Elimina el Worker y no queda nada.','fin.cta1':'Pruébalo ahora','fin.cta2':'Leer la documentación',
 'ft.tag':'Monitorización de uptime y páginas de estado de código abierto para Cloudflare Workers y Postgres.','ft.alt':'Alternativas','ft.for':'Casos de uso','ft.ios':'App para iOS','ft.product':'Producto','ft.selfhost':'Autoalojamiento','ft.status':'Estado del sistema','ft.embed':'Insertar estado','ft.changelog':'Novedades','ft.dev':'Desarrolladores','ft.docs':'Documentación','ft.api':'Referencia de la API','ft.contrib':'Contribuir','ft.comm':'Comunidad','ft.sec':'Seguridad','ft.priv':'Privacidad','ft.terms':'Términos','ft.legal':'© 2026 colaboradores de Montral · Licencia MIT','ft.built':'Construido en abierto.'
}};

var EN={},root=document.documentElement,nodes=document.querySelectorAll('[data-i18n]');
nodes.forEach(function(el){EN[el.dataset.i18n]=el.textContent});
EN.title=document.title;EN.desc=document.querySelector('meta[name=description]').content;
EN.copied='Copied';
T.en=EN;
EN['ft.st.operational']='All systems operational';EN['ft.st.degraded']='Partial degradation';EN['ft.st.outage']='Major outage';
T['zh-CN']['ft.st.operational']='所有系统运行正常';T['zh-CN']['ft.st.degraded']='部分服务降级';T['zh-CN']['ft.st.outage']='服务中断';
T.ja['ft.st.operational']='すべて正常に稼働中';T.ja['ft.st.degraded']='一部で性能低下';T.ja['ft.st.outage']='障害発生中';
T.es['ft.st.operational']='Todos los sistemas operativos';T.es['ft.st.degraded']='Degradación parcial';T.es['ft.st.outage']='Interrupción grave';
/* our own status page: shown only when it exists */
fetch('/api/public/status/montral').then(function(r){return r.ok?r.json():null}).then(function(d){
  if(!d||!d.overall)return;
  ['cta-status','ft-status'].forEach(function(i){var e=document.getElementById(i);if(e)e.hidden=false});
  var a=document.getElementById('f-status'),k='ft.st.'+d.overall,l=root.getAttribute('lang'),x=T[l]||EN;
  a.className='f-status '+d.overall;document.getElementById('f-status-t').textContent=x[k]||EN[k];a.hidden=false;
}).catch(function(){});

function setLang(l){
  var d=T[l]||EN;
  nodes.forEach(function(el){var k=el.dataset.i18n;el.textContent=d[k]||EN[k]});
  document.title=d.title||EN.title;
  document.querySelector('meta[name=description]').content=d.desc||EN.desc;
  root.setAttribute('lang',l);
  document.querySelectorAll('#lang-menu a').forEach(function(b){
    var on=b.dataset.l===l;b.setAttribute('aria-checked',on);
    if(on)document.getElementById('lang-cur').textContent=b.textContent;
  });
  renderMonitors();
}
function setTheme(t){
  root.setAttribute('data-theme',t);
  try{localStorage.setItem('montral_theme',t)}catch(e){}
}

/* ---------- sample monitors (deterministic) ---------- */
function rng(s){return function(){s=(s*1664525+1013904223)%4294967296;return s/4294967296}}
var MON=[
  {k:'mon.api',m:'HTTPS · 1m',u:'99.99%',ms:'92 ms',seed:7,w:[],d:[]},
  {k:'mon.web',m:'HTTPS · 1m',u:'99.97%',ms:'148 ms',seed:21,w:[61],d:[]},
  {k:'mon.db',m:'TCP :5432 · 1m',u:'100%',ms:'4 ms',seed:42,w:[],d:[]},
  {k:'mon.pay',m:'Heartbeat · 5m',u:'99.92%',ms:'—',seed:63,w:[18,74],d:[41]}
];
var N=90,box=document.getElementById('mons');
EN['mon.db']='Database';
function renderMonitors(){
  var lang=root.getAttribute('lang'),d=T[lang]||EN;
  box.innerHTML='';
  MON.forEach(function(m){
    var r=rng(m.seed),bars='';
    for(var i=0;i<N;i++){
      var c=m.d.indexOf(i)>-1?'d':m.w.indexOf(i)>-1?'w':'';
      var h=c?100:(62+Math.floor(r()*38));
      bars+='<i class="'+c+'" style="height:'+h+'%"></i>';
    }
    box.insertAdjacentHTML('beforeend',
      '<div class="mon"><div class="mon-n"><i></i><div>'+(d[m.k]||EN[m.k])+'<small>'+m.m+'</small></div></div>'+
      '<div class="bars">'+bars+'</div><div class="mon-v"><b>'+m.u+'</b>'+m.ms+'</div></div>');
  });
}

/* ---------- wiring ---------- */
(function(){
  var btn=document.getElementById('lang'),menu=document.getElementById('lang-menu');
  function close(){menu.classList.remove('open');btn.setAttribute('aria-expanded','false')}
  btn.addEventListener('click',function(e){e.stopPropagation();var o=menu.classList.toggle('open');btn.setAttribute('aria-expanded',o)});
  /* the options are real links (crawlers follow them to each language); a click also remembers the choice */
  menu.addEventListener('click',function(e){var a=e.target.closest('a[data-l]');if(a)document.cookie='montral_lang='+a.dataset.l+';path=/;max-age=31536000;samesite=lax'});
  document.addEventListener('click',close);
  document.addEventListener('keydown',function(e){if(e.key==='Escape')close()});
})();
document.getElementById('theme').addEventListener('click',function(){
  setTheme(root.getAttribute('data-theme')==='dark'?'light':'dark');
});
if('IntersectionObserver' in window){
  var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}})},{threshold:.12,rootMargin:'0px 0px -6% 0px'});
  document.querySelectorAll('.rv').forEach(function(el){io.observe(el)});
}else{document.querySelectorAll('.rv').forEach(function(el){el.classList.add('in')})}

setLang(root.getAttribute('lang'));

// Signed-in visitors get a dashboard link instead of "Sign in" (page is cached, so ask the API client-side).
fetch('/api/me',{credentials:'include'}).then(function(r){
  if(!r.ok)return;
  document.getElementById('signin').hidden=true;
  document.getElementById('go-app').hidden=false;
}).catch(function(){});
