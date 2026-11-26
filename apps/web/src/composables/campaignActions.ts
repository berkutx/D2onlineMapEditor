/**
 * Campaign actions with their messages — ONE implementation for the File menu, the campaign
 * bar and the campaign dialogs, so the surfaces can never drift.
 */
import { ElMessage, ElNotification } from "element-plus";
import type { CampaignRaceKey } from "@d2/socket-contract";
import { useCampaignStore } from "../stores/campaignStore";
import { tr } from "../i18n";

/** The race names a saga is shown with (the same words as «Новая карта»). */
export const CAMPAIGN_RACE_LABELS: Record<CampaignRaceKey, string> = {
  empire: tr("Империя"),
  clans: tr("Кланы Гор"),
  legions: tr("Легионы Проклятых"),
  undead: tr("Орды Нежити"),
  elves: tr("Эльфийский Союз"),
  neutral: tr("Нейтралы"),
};

export const raceLabel = (race: CampaignRaceKey | null): string => (race ? CAMPAIGN_RACE_LABELS[race] : "?");

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The native file picker for one file; null when nothing was picked. */
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    const done = (file: File | null): void => {
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => done(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}

export function useCampaignActions() {
  const campaign = useCampaignStore();

  async function openCampaign(id: string, mission = 0): Promise<boolean> {
    try {
      await campaign.open(id, mission);
      return true;
    } catch (e) {
      ElMessage.error(tr("Не удалось открыть кампанию: {error}", { error: message(e) }));
      return false;
    }
  }

  async function openMission(index: number): Promise<void> {
    try {
      await campaign.openMission(index);
    } catch (e) {
      ElMessage.error(tr("Не удалось открыть миссию: {error}", { error: message(e) }));
    }
  }

  async function step(dir: -1 | 1): Promise<void> {
    try {
      await campaign.step(dir);
    } catch (e) {
      ElMessage.error(tr("Не удалось открыть миссию: {error}", { error: message(e) }));
    }
  }

  /** «Загрузить кампанию (.csg)»: the saga's missions become this browser's own maps. */
  async function uploadCsg(): Promise<boolean> {
    const file = await pickFile(".csg");
    if (!file) return false;
    try {
      const c = await campaign.upload(file);
      ElMessage.success(
        tr("Загружена кампания «{name}»: её миссии стали вашими картами", { name: c.header.name || file.name }),
      );
      return true;
    } catch (e) {
      ElNotification({ title: tr("Кампания не загружена"), message: message(e), type: "error", duration: 0 });
      return false;
    }
  }

  /** «Экспорт кампании»: the `.csg` with every mission's edits, each checked like a map export. */
  async function exportCsg(): Promise<void> {
    if (!campaign.current) {
      ElMessage.warning(tr("Сначала откройте кампанию"));
      return;
    }
    try {
      const r = await campaign.exportCsg();
      if (!r) return;
      if (r.ok) {
        ElMessage.success(tr("Готова сага «{name}»", { name: r.filename }));
        return;
      }
      const reason =
        r.report?.semantic.reason || r.report?.structural.errors[0] || r.error || tr("карта не прошла проверку");
      ElNotification({
        title: tr("Сага не собрана"),
        message:
          r.mission !== undefined
            ? tr("Миссия {index} «{title}»: {reason}", { index: r.mission + 1, title: r.title ?? "", reason })
            : reason,
        type: "error",
        duration: 0,
      });
    } catch (e) {
      ElMessage.error(tr("Экспорт кампании не удался: {error}", { error: message(e) }));
    }
  }

  /** Add the open map to the current campaign as its last mission. */
  async function addMission(mapId: string): Promise<void> {
    try {
      await campaign.addMission(mapId);
      ElMessage.success(tr("Карта добавлена в кампанию последней миссией"));
    } catch (e) {
      ElMessage.error(tr("Не удалось изменить кампанию: {error}", { error: message(e) }));
    }
  }

  return { openCampaign, openMission, step, uploadCsg, exportCsg, addMission };
}
