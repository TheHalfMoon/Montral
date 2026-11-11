import { t } from "../lib/i18n";

/**
 * Shown instead of the page while the active workspace is suspended by a platform operator (every workspace API call
 * answers 403 `workspace_suspended`). Says what that means in plain words; never the reason or the operator's note,
 * which the API does not reveal. The workspace switcher in the sidebar keeps working.
 */
export default function SuspendedNotice() {
  return (
    <section className="card suspended" role="alert" aria-labelledby="suspended-title" data-suspended="">
      <h1 id="suspended-title">{t("This workspace is suspended")}</h1>
      <p>{t("Montral has suspended this workspace. While it is suspended you cannot view or change it.")}</p>
      <ul>
        <li>{t("Nothing has been deleted: monitors, incidents, history and members are kept.")}</li>
        <li>{t("Scheduled checks, alerts, webhook capture and public status pages are paused.")}</li>
        <li>{t("Everything resumes as soon as the suspension is lifted.")}</li>
      </ul>
      <p className="muted">{t("Contact support to resolve it. You can still switch to another workspace from the workspace menu.")}</p>
    </section>
  );
}
