/* ---------- i18n ---------- */
// English lives in the HTML itself; it is captured once and used as the fallback.
var T={
'zh-CN':{
 title:'Montral — 开源监控、事件响应与状态页',
 desc:'让每一次变化都无法被忽视。Montral 是开源的网站、API 与基础设施监控平台，内置事件管理、值班、状态页、Webhook 调试和 MCP 服务，可免费自托管。',
 'nav.skip':'跳到正文','nav.product':'产品','nav.features':'功能','nav.solutions':'解决方案','nav.open':'开源','nav.docs':'文档','nav.signin':'登录','nav.start':'开始使用','nav.app':'进入控制台',
 'hero.eyebrow':'开源监控与事件响应','hero.h1a':'让每一次变化','hero.h1b':'都无法被忽视。',
 'hero.lead':'Montral 从你选择的地区检测网站、API 和基础设施；一旦越过阈值就立即创建事件、通知值班人员，并让客户及时了解进展。一个可以自己部署的开源平台。',
 'hero.cta1':'开始使用','hero.cta2':'自托管 Montral','hero.live':'实时状态','hero.note':'基于 MIT 许可开源。软件本身不收集任何遥测数据。',
 'demo.h':'Montral 产品一览','demo.tab1':'监控','demo.tab2':'事件','demo.tab3':'状态页','demo.tab4':'Webhook',
 'app.monitors':'监控','app.incidents':'事件','app.oncall':'值班','app.status':'状态页','app.hooks':'Webhook','app.alerting':'告警',
 'demo.m.title':'监控','demo.range':'最近 90 次检测','demo.m.k1':'可用率 · 30 天','demo.m.k2':'平均响应时间','demo.m.k3':'进行中的事件',
 'demo.sample':'示例数据。本页演示中的名称和数字均为虚构。',
 'demo.i.sev':'严重','demo.i.auto':'自动检测','demo.i.ack':'已确认','demo.i.title':'eu-central 地区的结账 API 返回 503',
 'demo.i.t1':'已检测到：3 个地区全部失败','demo.i.t2':'已通过 Slack 和推送通知主值班人','demo.i.t3':'Sam R. 已确认','demo.i.t4':'进展：正在回滚最近一次发布','demo.i.t5':'已恢复：所有地区检测通过',
 'demo.i.ctx':'上下文','demo.i.mon':'监控项','demo.i.reg':'地区','demo.i.esc':'升级策略','demo.i.escv':'先主值班，再副值班','demo.i.page':'状态页','demo.i.pagev':'已同步','demo.i.dur':'持续时间',
 'demo.s.sub':'订阅更新','demo.s.ok':'所有系统运行正常','demo.s.c1':'网站','demo.s.c2':'API','demo.s.c3':'控制台','demo.s.ago':'90 天前','demo.s.today':'今天',
 'demo.w.title':'Webhook 收件箱','demo.w.count':'已捕获请求','demo.w.replay':'重放','demo.w.resp':'自定义响应：200、JSON 正文、延迟 250 毫秒',
 'loop.eyebrow':'工作方式','loop.title':'从第一次检测失败，到全部恢复，一个闭环。','loop.lead':'每一步都在同一个产品里交接给下一步，故障期间不必在不同工具之间来回复制信息。',
 'loop.o.t':'观察','loop.o.d':'HTTP、TCP、DNS、Ping、WebSocket、数据库、心跳和浏览器检测，按你设定的频率运行。',
 'loop.d.t':'发现','loop.d.d':'多个地区的探针达成一致后才会告警，单条线路抖动不会把人叫醒。',
 'loop.r.t':'响应','loop.r.d':'自动创建事件，告警按值班表和升级策略送达。',
 'loop.s.t':'恢复','loop.s.d':'发布进展、标记恢复、保留时间线。状态页同步更新。',
 'feat.eyebrow':'核心能力','feat.title':'监控、事件、值班和状态页，集中在一处。',
 'f.mon.e':'监控','f.mon.t':'各类检测，从你选择的地区发起。','f.mon.d':'可以校验状态码、关键字和响应头，而不只是看端口通不通。检测可从多个地区探针发起，只有它们一致判定失败时才告警。',
 'f.mon.1':'每个监控单独设置频率和超时','f.mon.2':'暂停、恢复、立即检测','f.mon.3':'以 JSON 导入和导出监控',
 't.http':'状态码、关键字、响应头','t.tcp':'端口可达','t.dns':'记录值','t.ping.n':'Ping','t.ws':'握手与应答','t.hb.n':'心跳','t.hb':'定时任务、后台进程','t.db':'查询健康','t.redis':'连接检测','t.br.n':'浏览器流程','t.br':'隔离运行器','t.cert.n':'证书','t.cert':'TLS 到期','t.dom.n':'域名','t.dom':'注册到期','t.reg.n':'多地区','t.reg':'探针共识',
 'f.inc.e':'事件','f.inc.t':'一条经得起回溯的时间线。','f.inc.d':'检测失败会自动创建事件，也可以手动声明。每一次发现、确认、更新和恢复都有时间和责任人。',
 'f.inc.1':'确认、发布进展、标记恢复','f.inc.2':'根因与复盘记录','f.inc.3':'每个事件都有告警送达记录',
 'f.oc.e':'值班','f.oc.t':'找到对的人，只通知一次。','f.oc.d':'支持轮换层与临时替班的值班表、无人确认时自动升级的策略，以及可订阅到个人日历的日历源。',
 'f.oc.1':'轮换正确处理时区和夏令时','f.oc.2':'换班和休假的临时替班','f.oc.3':'维护窗口暂停告警，但保留记录',
 'd.mon':'周一','d.tue':'周二','d.wed':'周三','d.thu':'周四','d.fri':'周五','d.sat':'周六','d.sun':'周日','oc.pri':'主值班','oc.sec':'副值班','oc.now':'当前值班：Sam R.，至你所在时区周四 09:00',
 'f.al.e':'告警','f.al.t':'告警送到团队已经在用的地方。','f.al.d':'每个监控都可以通知各自的渠道。上线前先发一条测试，需要时还能查看送达记录。','ch.push':'iOS 推送',
 'f.st.e':'状态页','f.st.t':'在客户发问之前告诉他们。','f.st.d':'公开或私有的状态页，可绑定自己的域名，包含组件分组、90 天历史、事件进展、维护公告和邮件订阅。',
 'f.st.1':'自定义域名与 DNS 验证','f.st.2':'密码保护和分享链接','f.st.3':'RSS、日历源、徽章和嵌入',
 'f.wh.e':'Webhook','f.wh.t':'看清每一个 Webhook，随时重放。','f.wh.d':'把服务方的回调指向收件箱，查看每个请求的方法、请求头和正文，自定义返回的响应，并把捕获的请求重放到你指定的地址。',
 'dev.e':'开发者','dev.t':'能点的，就能自动化。','dev.d':'带权限范围的 REST API 密钥、面向 AI Agent 并经 OAuth 授权的 MCP 服务，以及可从源码构建的 Terraform Provider。',
 'dev.api.t':'REST API','dev.api.d':'密钥可以限定到指定项目，只显示一次，随后以哈希形式保存。','dev.api.l':'API 参考',
 'dev.mcp.t':'面向 AI Agent 的 MCP','dev.mcp.d':'接入 Claude、Cursor 或任意 MCP 客户端，每个客户端都需要通过 OAuth 授权读或写权限。','dev.mcp.l':'MCP 指南',
 'dev.emb.t':'嵌入与订阅源','dev.emb.d':'每个公开状态页都提供状态徽章、JSON 摘要、RSS 和日历源。','dev.emb.l':'嵌入指南',
 'open.e':'开源','open.t':'你的监控，不该依赖别人的可用性。','open.d':'阅读代码、部署到自己的服务器、贡献改进。API、Web 应用和探针都在同一个 MIT 许可的仓库里。',
 'ed.c.t':'社区版','ed.c.l':'免费','ed.c.d':'自托管，不计量。全部核心功能运行在你自己的服务器上，没有套餐、配额或升级提示。','ed.c.a':'自托管指南',
 'ed.cl.t':'云服务','ed.cl.l':'尚未开放','ed.cl.d':'由 Montral 项目运营的托管版本正在筹备中，目前尚未公开发布，也没有提供任何套餐或价格。','ed.cl.a':'关注更新日志',
 'ed.b.t':'你的云','ed.b.d':'在你掌控的基础设施中运行 Montral，支持 OpenID Connect 单点登录、SCIM 用户同步和审计日志。','ed.b.a':'部署文档',
 'sh.t':'几条命令就能跑起来。','sh.d':'Docker Compose 会连同 PostgreSQL 一起启动。先在 .env 中设置数据库密码；备份、升级和地区探针见自托管指南。','sh.contrib':'如何参与贡献',
 'faq.t':'常见问题','faq.q1':'Montral 真的免费吗？','faq.a1':'是的。Montral 社区版基于 MIT 许可开源，不做任何用量计量。你只需为运行它的服务器付费。',
 'faq.q2':'可以监控什么？','faq.a2':'通过 HTTP / HTTPS 访问的网站和 API、TCP 端口、DNS 记录、Ping、WebSocket、PostgreSQL、MySQL 和 Redis、定时任务心跳、TLS 证书、域名到期，以及多步骤浏览器流程。',
 'faq.q3':'告警如何送达团队？','faq.a3':'通过你接入的渠道，例如 Slack、Microsoft Teams、PagerDuty、邮件或 Webhook，并按值班表和升级策略路由。邮件和推送需要在部署中配置服务商。',
 'faq.q4':'AI Agent 能使用吗？','faq.a4':'可以。Montral 内置 MCP 服务。Agent 通过 OAuth 接入，申请读或写权限，并受与其用户相同的项目范围限制。',
 'faq.q5':'有托管版本吗？','faq.a5':'暂时没有。托管版本正在筹备，尚未公开提供，也未公布任何套餐或价格。目前请通过自托管使用 Montral。',
 'final.a':'监控。','final.b':'响应。','final.c':'恢复。','final.d':'从一个监控开始。需要时，再加上值班、状态页和第一个 Webhook 收件箱。','final.docs':'阅读文档',
 'ft.tag':'开源的服务可靠性平台。让每一次变化都无法被忽视。','ft.product':'产品','ft.for':'使用场景','ft.alt':'方案对比','ft.ios':'iOS 应用','ft.changelog':'更新日志','ft.status':'系统状态',
 'ft.dev':'开发者','ft.selfhost':'自托管','ft.regions':'地区探针','ft.embed':'嵌入状态','ft.comm':'项目','ft.contrib':'参与贡献','ft.sec':'安全','ft.priv':'隐私','ft.terms':'条款','ft.legal':'© 2026 Montral 贡献者 · MIT 许可',
 'mon.api':'公开 API','mon.web':'官网','mon.db':'主数据库','mon.pay':'支付回调','st.up':'正常','st.deg':'性能下降','st.down':'不可用','theme':'切换主题','menu':'菜单'
},
ja:{
 title:'Montral — オープンソースの監視・インシデント対応・ステータスページ',
 desc:'変化を、見逃さない。Montral はウェブサイト、API、インフラを監視するオープンソースのプラットフォームです。インシデント管理、オンコール、ステータスページ、Webhook の確認、MCP サーバーを備え、無料でセルフホストできます。',
 'nav.skip':'本文へ移動','nav.product':'製品','nav.features':'機能','nav.solutions':'ソリューション','nav.open':'オープンソース','nav.docs':'ドキュメント','nav.signin':'ログイン','nav.start':'はじめる','nav.app':'ダッシュボード',
 'hero.eyebrow':'オープンソースの監視とインシデント対応','hero.h1a':'変化を、','hero.h1b':'見逃さない。',
 'hero.lead':'Montral は選んだリージョンからウェブサイト、API、インフラを確認し、しきい値を越えた瞬間にインシデントを起票して当番に通知し、顧客にも状況を伝えます。自分で運用できるオープンソースのプラットフォームです。',
 'hero.cta1':'はじめる','hero.cta2':'Montral をセルフホスト','hero.live':'稼働状況','hero.note':'MIT ライセンスのオープンソース。ソフトウェア自体はテレメトリを収集しません。',
 'demo.h':'Montral の中身','demo.tab1':'監視','demo.tab2':'インシデント','demo.tab3':'ステータスページ','demo.tab4':'Webhook',
 'app.monitors':'モニター','app.incidents':'インシデント','app.oncall':'オンコール','app.status':'ステータスページ','app.hooks':'Webhook','app.alerting':'アラート',
 'demo.m.title':'モニター','demo.range':'直近 90 回のチェック','demo.m.k1':'可用性 · 30 日','demo.m.k2':'平均応答時間','demo.m.k3':'対応中のインシデント',
 'demo.sample':'サンプルデータです。このツアーの名前と数値はすべて架空のものです。',
 'demo.i.sev':'重大','demo.i.auto':'自動検知','demo.i.ack':'確認済み','demo.i.title':'eu-central で決済 API が 503 を返している',
 'demo.i.t1':'検知：3 リージョンすべてで失敗','demo.i.t2':'Slack とプッシュで一次当番に通知','demo.i.t3':'Sam R. が確認','demo.i.t4':'更新：直前のデプロイをロールバック中','demo.i.t5':'解決：全リージョンでチェック成功',
 'demo.i.ctx':'コンテキスト','demo.i.mon':'モニター','demo.i.reg':'リージョン','demo.i.esc':'エスカレーション','demo.i.escv':'一次、次に二次','demo.i.page':'ステータスページ','demo.i.pagev':'更新済み','demo.i.dur':'継続時間',
 'demo.s.sub':'更新を購読','demo.s.ok':'すべてのシステムが正常に稼働中','demo.s.c1':'ウェブサイト','demo.s.c2':'API','demo.s.c3':'ダッシュボード','demo.s.ago':'90 日前','demo.s.today':'今日',
 'demo.w.title':'Webhook 受信箱','demo.w.count':'受信したリクエスト','demo.w.replay':'リプレイ','demo.w.resp':'カスタム応答：200、JSON 本文、250 ミリ秒の遅延',
 'loop.eyebrow':'しくみ','loop.title':'最初の失敗から復旧まで、ひとつのループで。','loop.lead':'各ステップは同じ製品の中で次へ引き継がれるので、障害の最中にツール間で情報を写す必要はありません。',
 'loop.o.t':'観測','loop.o.d':'HTTP、TCP、DNS、Ping、WebSocket、データベース、ハートビート、ブラウザのチェックを設定した間隔で実行します。',
 'loop.d.t':'検知','loop.d.d':'複数リージョンのプローブが一致してから通知するので、一つの経路の不調で誰かを起こすことはありません。',
 'loop.r.t':'対応','loop.r.d':'インシデントが起票され、アラートはオンコール表とエスカレーションポリシーに従って届きます。',
 'loop.s.t':'復旧','loop.s.d':'更新を投稿し、解決し、タイムラインを残します。ステータスページも同時に更新されます。',
 'feat.eyebrow':'機能','feat.title':'監視、インシデント、オンコール、ステータスページをひとつに。',
 'f.mon.e':'監視','f.mon.t':'あらゆるチェックを、選んだリージョンから。','f.mon.d':'ポートが応答するかだけでなく、ステータスコード、キーワード、ヘッダーを検証できます。複数のリージョンプローブから実行し、結果が一致したときだけ通知します。',
 'f.mon.1':'モニターごとの間隔とタイムアウト','f.mon.2':'一時停止、再開、今すぐチェック','f.mon.3':'JSON でモニターをインポート・エクスポート',
 't.http':'ステータス、キーワード、ヘッダー','t.tcp':'ポート到達性','t.dns':'レコードの値','t.ping.n':'Ping','t.ws':'ハンドシェイクと応答','t.hb.n':'ハートビート','t.hb':'cron ジョブ、ワーカー','t.db':'クエリの健全性','t.redis':'接続チェック','t.br.n':'ブラウザジャーニー','t.br':'隔離されたランナー','t.cert.n':'証明書','t.cert':'TLS の有効期限','t.dom.n':'ドメイン','t.dom':'登録の有効期限','t.reg.n':'マルチリージョン','t.reg':'プローブの合意',
 'f.inc.e':'インシデント','f.inc.t':'記録として残るタイムライン。','f.inc.d':'失敗したチェックは自動でインシデントを起票し、手動で宣言することもできます。検知、確認、更新、解決のすべてに時刻と担当者が記録されます。',
 'f.inc.1':'確認、更新の投稿、解決','f.inc.2':'根本原因とポストモーテムのメモ','f.inc.3':'インシデントごとのアラート配信履歴',
 'f.oc.e':'オンコール','f.oc.t':'適任者に、一度だけ通知。','f.oc.d':'ローテーションのレイヤーと臨時交代を備えたスケジュール、誰も確認しないときに段階を上げるエスカレーションポリシー、個人のカレンダーで購読できるフィード。',
 'f.oc.1':'タイムゾーンと夏時間に対応したローテーション','f.oc.2':'交代や休暇のための一時的な代理','f.oc.3':'メンテナンス時間中はアラートを止め、記録は残す',
 'd.mon':'月','d.tue':'火','d.wed':'水','d.thu':'木','d.fri':'金','d.sat':'土','d.sun':'日','oc.pri':'一次','oc.sec':'二次','oc.now':'現在の当番：Sam R.（あなたの時間で木曜 09:00 まで）',
 'f.al.e':'アラート','f.al.t':'アラートは、チームがすでに使っている場所へ。','f.al.d':'モニターごとに通知先を設定できます。頼る前にテスト送信し、必要なときには配信ログで何が送られたかを確認できます。','ch.push':'iOS プッシュ',
 'f.st.e':'ステータスページ','f.st.t':'聞かれる前に、伝える。','f.st.d':'独自ドメインで公開または非公開のページを。コンポーネントのグループ、90 日間の履歴、インシデントの更新、メンテナンスのお知らせ、メール購読を備えています。',
 'f.st.1':'DNS で確認する独自ドメイン','f.st.2':'パスワード保護と共有リンク','f.st.3':'RSS、カレンダーフィード、バッジ、埋め込み',
 'f.wh.e':'Webhook','f.wh.t':'すべての Webhook を確認し、いつでもリプレイ。','f.wh.d':'プロバイダーの送信先を受信箱に向け、各リクエストのメソッド、ヘッダー、本文を確認し、返す応答を選び、受信したリクエストを指定した宛先にリプレイできます。',
 'dev.e':'開発者','dev.t':'クリックできることは、自動化できる。','dev.d':'スコープ付きキーの REST API、OAuth で同意する AI エージェント向け MCP サーバー、ソースからビルドできる Terraform プロバイダー。',
 'dev.api.t':'REST API','dev.api.d':'キーは特定のプロジェクトに限定できます。表示は一度だけで、その後はハッシュとして保存されます。','dev.api.l':'API リファレンス',
 'dev.mcp.t':'AI エージェント向け MCP','dev.mcp.d':'Claude、Cursor など任意の MCP クライアントを接続できます。各クライアントは OAuth で読み取りまたは書き込みの許可を求めます。','dev.mcp.l':'MCP ガイド',
 'dev.emb.t':'埋め込みとフィード','dev.emb.d':'公開ステータスページごとに、ステータスバッジ、JSON サマリー、RSS、カレンダーフィードを提供します。','dev.emb.l':'埋め込みガイド',
 'open.e':'オープンソース','open.t':'監視が、他人の稼働率に左右されてはいけない。','open.d':'コードを読み、自分のハードウェアで動かし、改善を還元できます。API、ウェブアプリ、プローブは MIT ライセンスのひとつのリポジトリにあります。',
 'ed.c.t':'Community','ed.c.l':'無料','ed.c.d':'セルフホストで、従量課金なし。すべての主要機能を自分のサーバーで。プラン、クォータ、アップグレードの案内はありません。','ed.c.a':'セルフホストガイド',
 'ed.cl.t':'Cloud','ed.cl.l':'未提供','ed.cl.d':'Montral プロジェクトが運営するホスト版を準備中です。まだ一般公開されておらず、プランや価格も提供していません。','ed.cl.a':'変更履歴をフォロー',
 'ed.b.t':'自社クラウド','ed.b.d':'管理下のインフラで Montral を運用。OpenID Connect のシングルサインオン、SCIM プロビジョニング、監査ログに対応します。','ed.b.a':'デプロイのドキュメント',
 'sh.t':'数コマンドで動きます。','sh.d':'Docker Compose がアプリと専用の PostgreSQL を起動します。先に .env でデータベースのパスワードを設定してください。バックアップ、アップグレード、リージョンプローブはセルフホストガイドで解説しています。','sh.contrib':'コントリビュートの方法',
 'faq.t':'よくある質問','faq.q1':'Montral は本当に無料ですか？','faq.a1':'はい。Montral Community は MIT ライセンスのオープンソースで、利用量の計測はありません。費用は動かすサーバーの分だけです。',
 'faq.q2':'何を監視できますか？','faq.a2':'HTTP / HTTPS のウェブサイトと API、TCP ポート、DNS レコード、Ping、WebSocket、PostgreSQL・MySQL・Redis、定期ジョブのハートビート、TLS 証明書、ドメインの有効期限、複数ステップのブラウザジャーニーです。',
 'faq.q3':'アラートはどうチームに届きますか？','faq.a3':'Slack、Microsoft Teams、PagerDuty、メール、Webhook など接続したチャネルに、オンコール表とエスカレーションポリシーに従って届きます。メールとプッシュにはデプロイ側でプロバイダーの設定が必要です。',
 'faq.q4':'AI エージェントから使えますか？','faq.a4':'はい。Montral は MCP サーバーを内蔵しています。エージェントは OAuth で接続して読み取りまたは書き込みの許可を求め、ユーザーと同じプロジェクトの範囲内で動作します。',
 'faq.q5':'ホスト版はありますか？','faq.a5':'まだありません。ホスト版は準備中ですが一般には提供されておらず、プランや価格も公開していません。現在はセルフホストでご利用ください。',
 'final.a':'監視する。','final.b':'対応する。','final.c':'復旧する。','final.d':'まずはモニターをひとつ。必要になったら、オンコール、ステータスページ、最初の Webhook 受信箱を追加しましょう。','final.docs':'ドキュメントを読む',
 'ft.tag':'オープンソースのサービス信頼性プラットフォーム。変化を、見逃さない。','ft.product':'製品','ft.for':'ユースケース','ft.alt':'比較','ft.ios':'iOS アプリ','ft.changelog':'変更履歴','ft.status':'システムの状態',
 'ft.dev':'開発者','ft.selfhost':'セルフホスト','ft.regions':'リージョンプローブ','ft.embed':'ステータスの埋め込み','ft.comm':'プロジェクト','ft.contrib':'コントリビュート','ft.sec':'セキュリティ','ft.priv':'プライバシー','ft.terms':'利用規約','ft.legal':'© 2026 Montral コントリビューター · MIT ライセンス',
 'mon.api':'公開 API','mon.web':'ウェブサイト','mon.db':'プライマリ DB','mon.pay':'決済 Webhook','st.up':'正常','st.deg':'低下','st.down':'停止','theme':'テーマを切り替え','menu':'メニュー'
},
es:{
 title:'Montral — Monitorización, incidentes y páginas de estado de código abierto',
 desc:'Que ningún cambio pase desapercibido. Montral es monitorización de código abierto para webs, API e infraestructura, con incidentes, guardias, páginas de estado, inspección de webhooks y un servidor MCP. Autoalójalo gratis.',
 'nav.skip':'Saltar al contenido','nav.product':'Producto','nav.features':'Funciones','nav.solutions':'Soluciones','nav.open':'Código abierto','nav.docs':'Documentación','nav.signin':'Iniciar sesión','nav.start':'Empezar','nav.app':'Panel',
 'hero.eyebrow':'Monitorización y respuesta a incidentes de código abierto','hero.h1a':'Que ningún cambio','hero.h1b':'pase desapercibido.',
 'hero.lead':'Montral comprueba tus webs, API e infraestructura desde las regiones que elijas, abre un incidente en cuanto algo cruza el umbral, avisa a quien está de guardia y mantiene informados a tus clientes. Una plataforma de código abierto que puedes alojar tú mismo.',
 'hero.cta1':'Empezar','hero.cta2':'Autoalojar Montral','hero.live':'Estado en vivo','hero.note':'Código abierto con licencia MIT. El software no recopila telemetría.',
 'demo.h':'Un vistazo a Montral','demo.tab1':'Monitorización','demo.tab2':'Incidentes','demo.tab3':'Páginas de estado','demo.tab4':'Webhooks',
 'app.monitors':'Monitores','app.incidents':'Incidentes','app.oncall':'Guardias','app.status':'Páginas de estado','app.hooks':'Webhooks','app.alerting':'Alertas',
 'demo.m.title':'Monitores','demo.range':'Últimas 90 comprobaciones','demo.m.k1':'Disponibilidad · 30 días','demo.m.k2':'Respuesta media','demo.m.k3':'Incidentes abiertos',
 'demo.sample':'Datos de ejemplo. Todos los nombres y cifras de este recorrido son ficticios.',
 'demo.i.sev':'Crítico','demo.i.auto':'Detectado automáticamente','demo.i.ack':'Reconocido','demo.i.title':'La API de pago devuelve 503 en eu-central',
 'demo.i.t1':'Detectado: fallan 3 de 3 regiones','demo.i.t2':'Aviso a la guardia principal por Slack y push','demo.i.t3':'Reconocido por Sam R.','demo.i.t4':'Actualización: revirtiendo el último despliegue','demo.i.t5':'Resuelto: las comprobaciones pasan en todas las regiones',
 'demo.i.ctx':'Contexto','demo.i.mon':'Monitor','demo.i.reg':'Regiones','demo.i.esc':'Escalado','demo.i.escv':'Principal y luego secundaria','demo.i.page':'Página de estado','demo.i.pagev':'Actualizada','demo.i.dur':'Duración',
 'demo.s.sub':'Suscribirse','demo.s.ok':'Todos los sistemas operativos','demo.s.c1':'Web','demo.s.c2':'API','demo.s.c3':'Panel','demo.s.ago':'Hace 90 días','demo.s.today':'Hoy',
 'demo.w.title':'Bandeja de webhooks','demo.w.count':'Peticiones capturadas','demo.w.replay':'Reenviar','demo.w.resp':'Respuesta personalizada: 200, cuerpo JSON, 250 ms de retraso',
 'loop.eyebrow':'Cómo funciona','loop.title':'Un solo ciclo, del primer fallo a la normalidad.','loop.lead':'Cada paso pasa al siguiente dentro del mismo producto, así que nada se copia entre herramientas mientras algo está caído.',
 'loop.o.t':'Observar','loop.o.d':'Comprobaciones HTTP, TCP, DNS, ping, WebSocket, bases de datos, heartbeat y navegador con la frecuencia que decidas.',
 'loop.d.t':'Detectar','loop.d.d':'Las sondas regionales se ponen de acuerdo antes de avisar, así que una ruta inestable no despierta a nadie.',
 'loop.r.t':'Responder','loop.r.d':'Se abre un incidente y la alerta sigue tu calendario de guardias y tu política de escalado.',
 'loop.s.t':'Restaurar','loop.s.d':'Publica novedades, resuelve y conserva la cronología. Tu página de estado se actualiza a la vez.',
 'feat.eyebrow':'Capacidades','feat.title':'Monitorización, incidentes, guardias y páginas de estado en un solo lugar.',
 'f.mon.e':'Monitorización','f.mon.t':'Todo tipo de comprobación, desde las regiones que elijas.','f.mon.d':'Valida códigos de estado, palabras clave y cabeceras, no solo si un puerto responde. Las comprobaciones pueden ejecutarse desde varias sondas regionales y solo se avisa cuando coinciden.',
 'f.mon.1':'Intervalo y tiempo de espera por monitor','f.mon.2':'Pausar, reanudar y comprobar ahora','f.mon.3':'Importar y exportar monitores en JSON',
 't.http':'estado, palabra clave, cabeceras','t.tcp':'alcance del puerto','t.dns':'valores de registro','t.ping.n':'Ping','t.ws':'handshake y respuesta','t.hb.n':'Heartbeat','t.hb':'tareas cron, workers','t.db':'salud de consultas','t.redis':'conexión','t.br.n':'Recorridos de navegador','t.br':'ejecutor aislado','t.cert.n':'Certificados','t.cert':'caducidad TLS','t.dom.n':'Dominios','t.dom':'caducidad del registro','t.reg.n':'Multirregión','t.reg':'consenso de sondas',
 'f.inc.e':'Incidentes','f.inc.t':'Una cronología que sirve de registro.','f.inc.d':'Las comprobaciones fallidas abren incidentes solas y cualquiera puede declarar uno a mano. Cada detección, reconocimiento, actualización y resolución queda fechada y atribuida.',
 'f.inc.1':'Reconocer, publicar novedades y resolver','f.inc.2':'Causa raíz y notas del postmortem','f.inc.3':'Historial de entregas de alertas en cada incidente',
 'f.oc.e':'Guardias','f.oc.t':'La persona adecuada, avisada una vez.','f.oc.d':'Calendarios con capas de rotación y sustituciones, políticas de escalado que suben de nivel si nadie responde y un feed para el calendario de cada persona.',
 'f.oc.1':'Rotaciones que respetan zonas horarias y horario de verano','f.oc.2':'Sustituciones puntuales para cambios y vacaciones','f.oc.3':'Ventanas de mantenimiento que detienen alertas, no el historial',
 'd.mon':'Lun','d.tue':'Mar','d.wed':'Mié','d.thu':'Jue','d.fri':'Vie','d.sat':'Sáb','d.sun':'Dom','oc.pri':'Principal','oc.sec':'Secundaria','oc.now':'De guardia ahora: Sam R., hasta el jueves a las 09:00 de tu hora',
 'f.al.e':'Alertas','f.al.t':'Las alertas llegan donde tu equipo ya trabaja.','f.al.d':'Cada monitor puede avisar a sus propios canales. Prueba un canal antes de depender de él y consulta el registro de entregas cuando necesites saber qué se envió.','ch.push':'Push en iOS',
 'f.st.e':'Páginas de estado','f.st.t':'Informa a tus clientes antes de que pregunten.','f.st.d':'Páginas públicas o privadas en tu propio dominio, con componentes agrupados, noventa días de historial, novedades de incidentes, avisos de mantenimiento y suscripciones por correo.',
 'f.st.1':'Dominios propios verificados por DNS','f.st.2':'Protección con contraseña y enlaces para compartir','f.st.3':'RSS, feed de calendario, insignia e inserción',
 'f.wh.e':'Webhooks','f.wh.t':'Inspecciona cada webhook. Reenvía cualquiera.','f.wh.d':'Apunta un proveedor a una bandeja, lee el método, las cabeceras y el cuerpo de cada petición, elige la respuesta que recibe y reenvía una petición capturada al destino que indiques.',
 'dev.e':'Desarrolladores','dev.t':'Lo que puedes pulsar, puedes automatizarlo.','dev.d':'Una API REST con claves con alcance, un servidor MCP para agentes de IA con consentimiento OAuth y un proveedor de Terraform que puedes compilar desde el código.',
 'dev.api.t':'API REST','dev.api.d':'Las claves pueden limitarse a proyectos concretos. Se muestran una vez y se guardan cifradas con hash.','dev.api.l':'Referencia de la API',
 'dev.mcp.t':'MCP para agentes de IA','dev.mcp.d':'Conecta Claude, Cursor o cualquier cliente MCP. Cada uno pide acceso de lectura o escritura mediante consentimiento OAuth.','dev.mcp.l':'Guía de MCP',
 'dev.emb.t':'Inserciones y feeds','dev.emb.d':'Insignias de estado, un resumen JSON y feeds RSS y de calendario para cada página de estado pública.','dev.emb.l':'Guía de inserción',
 'open.e':'Código abierto','open.t':'Tu monitorización no debería depender de la disponibilidad de otros.','open.d':'Lee el código, ejecútalo en tu propio hardware y contribuye. La API, la aplicación web y las sondas están en un solo repositorio con licencia MIT.',
 'ed.c.t':'Community','ed.c.l':'Gratis','ed.c.d':'Autoalojada y sin medición de uso. Todas las capacidades principales en tus servidores, sin planes, cuotas ni avisos de mejora.','ed.c.a':'Guía de autoalojamiento',
 'ed.cl.t':'Cloud','ed.cl.l':'Aún no disponible','ed.cl.d':'Se está preparando una edición alojada por el proyecto Montral. No se ha lanzado públicamente y todavía no se ofrecen planes ni precios.','ed.cl.a':'Sigue el registro de cambios',
 'ed.b.t':'Tu nube','ed.b.d':'Ejecuta Montral en la infraestructura que controlas, con inicio de sesión único OpenID Connect, aprovisionamiento SCIM y registros de auditoría.','ed.b.a':'Documentación de despliegue',
 'sh.t':'Funcionando con unos pocos comandos.','sh.d':'Docker Compose levanta la aplicación con su propio PostgreSQL. Primero define una contraseña de base de datos en .env; la guía de autoalojamiento explica copias de seguridad, actualizaciones y sondas regionales.','sh.contrib':'Cómo contribuir',
 'faq.t':'Preguntas','faq.q1':'¿Montral es realmente gratis?','faq.a1':'Sí. Montral Community es código abierto con licencia MIT y no mide el uso. Solo pagas los servidores donde lo ejecutas.',
 'faq.q2':'¿Qué puede monitorizar?','faq.a2':'Webs y API por HTTP y HTTPS, puertos TCP, registros DNS, ping, WebSocket, PostgreSQL, MySQL y Redis, heartbeats de tareas programadas, certificados TLS, caducidad de dominios y recorridos de navegador de varios pasos.',
 'faq.q3':'¿Cómo llegan las alertas a mi equipo?','faq.a3':'Por los canales que conectes, como Slack, Microsoft Teams, PagerDuty, correo o un webhook, según tus calendarios de guardia y políticas de escalado. El correo y las notificaciones push necesitan un proveedor configurado en tu despliegue.',
 'faq.q4':'¿Pueden usarlo los agentes de IA?','faq.a4':'Sí. Montral incluye un servidor MCP. Un agente se conecta con OAuth, pide acceso de lectura o escritura y trabaja dentro de los mismos límites de proyecto que su usuario.',
 'faq.q5':'¿Hay una versión alojada?','faq.a5':'Todavía no. Hay una edición alojada en preparación, pero no está disponible públicamente ni tiene planes o precios publicados. Hoy la forma de usar Montral es autoalojarlo.',
 'final.a':'Monitoriza.','final.b':'Responde.','final.c':'Restaura.','final.d':'Empieza con un monitor. Añade guardias, una página de estado y tu primera bandeja de webhooks cuando las necesites.','final.docs':'Leer la documentación',
 'ft.tag':'Fiabilidad de servicios de código abierto. Que ningún cambio pase desapercibido.','ft.product':'Producto','ft.for':'Casos de uso','ft.alt':'Comparativas','ft.ios':'App para iOS','ft.changelog':'Registro de cambios','ft.status':'Estado del sistema',
 'ft.dev':'Desarrolladores','ft.selfhost':'Autoalojamiento','ft.regions':'Sondas regionales','ft.embed':'Insertar estado','ft.comm':'Proyecto','ft.contrib':'Contribuir','ft.sec':'Seguridad','ft.priv':'Privacidad','ft.terms':'Términos','ft.legal':'© 2026 colaboradores de Montral · Licencia MIT',
 'mon.api':'API pública','mon.web':'Web','mon.db':'Base de datos principal','mon.pay':'Webhook de pagos','st.up':'Operativo','st.deg':'Degradado','st.down':'Caído','theme':'Cambiar tema','menu':'Menú'
}};

var EN={},root=document.documentElement,nodes=document.querySelectorAll('[data-i18n]');
nodes.forEach(function(el){EN[el.dataset.i18n]=el.textContent});
EN.title=document.title;EN.desc=document.querySelector('meta[name=description]').content;
EN['mon.api']='Public API';EN['mon.web']='Website';EN['mon.db']='Primary database';EN['mon.pay']='Payment webhook';
EN['st.up']='Up';EN['st.deg']='Degraded';EN['st.down']='Down';EN.theme='Toggle theme';EN.menu='Menu';
T.en=EN;
EN['ft.st.operational']='All systems operational';EN['ft.st.degraded']='Partial degradation';EN['ft.st.outage']='Major outage';
T['zh-CN']['ft.st.operational']='所有系统运行正常';T['zh-CN']['ft.st.degraded']='部分服务降级';T['zh-CN']['ft.st.outage']='服务中断';
T.ja['ft.st.operational']='すべて正常に稼働中';T.ja['ft.st.degraded']='一部で性能低下';T.ja['ft.st.outage']='障害発生中';
T.es['ft.st.operational']='Todos los sistemas operativos';T.es['ft.st.degraded']='Degradación parcial';T.es['ft.st.outage']='Interrupción grave';
function dict(){return T[root.getAttribute('lang')]||EN}
function tr(k){var d=dict();return d[k]||EN[k]||k}

/* our own status page: shown only when it exists */
fetch('/api/public/status/montral').then(function(r){return r.ok?r.json():null}).then(function(d){
  if(!d||['operational','degraded','outage'].indexOf(d.overall)<0)return;
  ['cta-status','ft-status'].forEach(function(i){var e=document.getElementById(i);if(e)e.hidden=false});
  var a=document.getElementById('f-status'),k='ft.st.'+d.overall;
  a.className='f-status '+d.overall;document.getElementById('f-status-t').textContent=tr(k);a.hidden=false;
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
  var th=document.getElementById('theme');th.setAttribute('aria-label',tr('theme'));th.title=tr('theme');
  var mn=document.querySelector('.m-nav summary');if(mn)mn.setAttribute('aria-label',tr('menu'));
  renderMonitors();
}
function setTheme(t){
  root.setAttribute('data-theme',t);
  try{localStorage.setItem('montral_theme',t)}catch(e){}
}

/* ---------- sample monitors and uptime bars (deterministic, synthetic) ---------- */
function rng(s){return function(){s=(s*1664525+1013904223)%4294967296;return s/4294967296}}
function bars(n,seed,w,d){
  var r=rng(seed),out='';
  for(var i=0;i<n;i++){
    var c=d.indexOf(i)>-1?'d':w.indexOf(i)>-1?'w':'';
    var h=c?100:(64+Math.floor(r()*36));
    out+='<i class="'+c+'" style="height:'+h+'%"></i>';
  }
  return out;
}
var MON=[
  {k:'mon.api',m:'HTTPS · 30s · eu/us/ap',u:'99.99%',ms:'92 ms',seed:7,w:[],d:[],s:'up'},
  {k:'mon.web',m:'Browser · 5m',u:'99.97%',ms:'1.4 s',seed:21,w:[61],d:[],s:'up'},
  {k:'mon.db',m:'PostgreSQL · 1m',u:'100%',ms:'4 ms',seed:42,w:[],d:[],s:'up'},
  {k:'mon.pay',m:'Heartbeat · 5m',u:'99.12%',ms:'—',seed:63,w:[18,74],d:[86,87,88,89],s:'down'}
];
var STC={up:'st.up',deg:'st.deg',down:'st.down'};
var box=document.getElementById('mons');
function renderMonitors(){
  box.innerHTML='';
  MON.forEach(function(m){
    box.insertAdjacentHTML('beforeend',
      '<div class="mon"><div class="mon-n"><span class="st '+m.s+'" role="img" aria-label="'+tr(STC[m.s])+'"></span><div>'+tr(m.k)+'<small>'+m.m+'</small></div></div>'+
      '<div class="bars" aria-hidden="true">'+bars(90,m.seed,m.w,m.d)+'</div><div class="mon-v"><b>'+m.u+'</b>'+m.ms+'</div></div>');
  });
}
document.querySelectorAll('[data-bars]').forEach(function(el){
  var num=function(a){return a?a.split(',').map(Number):[]};
  el.setAttribute('aria-hidden','true');
  el.innerHTML=bars(90,+el.dataset.bars,num(el.dataset.w),num(el.dataset.d));
});

/* ---------- product tour tabs (WAI-ARIA tabs pattern) ---------- */
(function(){
  var tabs=[].slice.call(document.querySelectorAll('[role=tab]')),side=document.querySelectorAll('.side [data-side]');
  function select(t,focus){
    tabs.forEach(function(x){
      var on=x===t,p=document.getElementById(x.getAttribute('aria-controls'));
      x.setAttribute('aria-selected',on);x.tabIndex=on?0:-1;
      p.hidden=!on;p.classList.toggle('on',on);
    });
    var key=t.id.slice(4);
    side.forEach(function(s){s.classList.toggle('on',s.dataset.side===key)});
    if(focus)t.focus();
  }
  tabs.forEach(function(t,i){
    t.addEventListener('click',function(){select(t)});
    t.addEventListener('keydown',function(e){
      var j=null;
      if(e.key==='ArrowRight')j=(i+1)%tabs.length;
      else if(e.key==='ArrowLeft')j=(i-1+tabs.length)%tabs.length;
      else if(e.key==='Home')j=0;
      else if(e.key==='End')j=tabs.length-1;
      else if(/^[1-4]$/.test(e.key))j=+e.key-1;
      if(j!==null){e.preventDefault();select(tabs[j],true)}
    });
  });
})();

/* ---------- wiring ---------- */
(function(){
  var btn=document.getElementById('lang'),menu=document.getElementById('lang-menu');
  function close(){menu.classList.remove('open');btn.setAttribute('aria-expanded','false')}
  btn.addEventListener('click',function(e){e.stopPropagation();var o=menu.classList.toggle('open');btn.setAttribute('aria-expanded',o)});
  /* the options are real links (crawlers follow them to each language); a click also remembers the choice */
  menu.addEventListener('click',function(e){var a=e.target.closest('a[data-l]');if(a)document.cookie='montral_lang='+a.dataset.l+';path=/;max-age=31536000;samesite=lax'});
  document.addEventListener('click',close);
  document.addEventListener('keydown',function(e){if(e.key==='Escape'){close();var m=document.querySelector('.m-nav[open]');if(m){m.open=false;m.querySelector('summary').focus()}}});
  /* the mobile menu closes after a choice */
  document.querySelectorAll('.m-panel a').forEach(function(a){a.addEventListener('click',function(){a.closest('details').open=false})});
})();
document.getElementById('theme').addEventListener('click',function(){
  setTheme(root.getAttribute('data-theme')==='dark'?'light':'dark');
});
(function(){
  var bar=document.getElementById('top-bar');
  function on(){bar.classList.toggle('scrolled',window.scrollY>8)}
  window.addEventListener('scroll',on,{passive:true});on();
})();
if('IntersectionObserver' in window){
  var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}})},{threshold:.12,rootMargin:'0px 0px -6% 0px'});
  document.querySelectorAll('.rv').forEach(function(el){io.observe(el)});
}else{document.querySelectorAll('.rv').forEach(function(el){el.classList.add('in')})}

setLang(root.getAttribute('lang'));

// Signed-in visitors get a dashboard link instead of "Sign in" (page is cached, so ask the API client-side).
fetch('/api/me',{credentials:'include'}).then(function(r){
  if(!r.ok)return;
  document.getElementById('signin').hidden=true;
  document.getElementById('get-started').hidden=true;
  document.getElementById('go-app').hidden=false;
}).catch(function(){});
