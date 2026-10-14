import type { RouteCheckpoint } from "../types/domain";

export type RecordedCheckpointPrompt = {
  phrase: string;
  fileName: string;
  label: string;
  description: string;
  recommendedTriggerMeters?: number;
  suggestedType?: RouteCheckpoint["type"];
};

export const RECORDED_CHECKPOINT_PROMPTS: RecordedCheckpointPrompt[] = [
  // Licensed Simulatori.ge Gori pack: stable per-event identifiers avoid collisions with the original DriveExam phrases.
  {
    phrase: "simulatori-gori/turn-left-soon",
    fileName: "simulatori-gori-turn-left-soon.mp3",
    label: "მალე გთხოვთ მოუხვიოთ მარცხნივ",
    description: "Simulatori.ge — მარცხნივ • მალე",
    suggestedType: "left",
  },
  {
    phrase: "simulatori-gori/turn-right-soon",
    fileName: "simulatori-gori-turn-right-soon.mp3",
    label: "მალე გთხოვთ მოუხვიოთ მარჯვნივ",
    description: "Simulatori.ge — მარჯვნივ • მალე",
    suggestedType: "right",
  },
  {
    phrase: "simulatori-gori/turn-left-300m",
    fileName: "simulatori-gori-turn-left-300m.mp3",
    label: "300 მეტრში მოუხვიეთ მარცხნივ",
    description: "Simulatori.ge — მარცხნივ • 300 მ",
    suggestedType: "left",
  },
  {
    phrase: "simulatori-gori/turn-right-300m",
    fileName: "simulatori-gori-turn-right-300m.mp3",
    label: "300 მეტრში მოუხვიეთ მარჯვნივ",
    description: "Simulatori.ge — მარჯვნივ • 300 მ",
    suggestedType: "right",
  },
  {
    phrase: "simulatori-gori/turn-right-500m",
    fileName: "simulatori-gori-turn-right-500m.mp3",
    label: "500 მეტრში მოუხვიეთ მარჯვნივ",
    description: "Simulatori.ge — მარჯვნივ • 500 მ",
    suggestedType: "right",
  },
  {
    phrase: "simulatori-gori/turn-left-500m",
    fileName: "simulatori-gori-turn-left-500m.mp3",
    label: "500 მეტრში მოუხვიეთ მარცხნივ",
    description: "Simulatori.ge — მარცხნივ • 500 მ",
    suggestedType: "left",
  },
  {
    phrase: "simulatori-gori/straight",
    fileName: "simulatori-gori-straight.mp3",
    label: "შემდეგ მინიშნებამდე იმოძრავეთ პირდაპირ",
    description: "Simulatori.ge — პირდაპირ • შემდეგ მინიშნებამდე",
    suggestedType: "straight",
  },
  {
    phrase: "simulatori-gori/straight-soon",
    fileName: "simulatori-gori-straight-soon.mp3",
    label: "მალე იმოძრავეთ პირდაპირ",
    description: "Simulatori.ge — პირდაპირ • მალე",
    suggestedType: "straight",
  },
  {
    phrase: "simulatori-gori/straight-300m",
    fileName: "simulatori-gori-straight-300m.mp3",
    label: "300 მეტრში იმოძრავეთ პირდაპირ",
    description: "Simulatori.ge — პირდაპირ • 300 მ",
    suggestedType: "straight",
  },
  {
    phrase: "simulatori-gori/roundabout-straight-300m",
    fileName: "simulatori-gori-roundabout-straight-300m.mp3",
    label: "300 მეტრში წრიულზე იმოძრავეთ პირდაპირ",
    description: "Simulatori.ge — წრიული მოძრაობა • 300 მ",
    suggestedType: "straight",
  },
  {
    phrase: "simulatori-gori/roundabout-straight-500m",
    fileName: "simulatori-gori-roundabout-straight-500m.mp3",
    label: "500 მეტრში წრიულზე იმოძრავეთ პირდაპირ",
    description: "Simulatori.ge — წრიული მოძრაობა • 500 მ",
    suggestedType: "straight",
  },
  {
    phrase: "simulatori-gori/exam-start",
    fileName: "simulatori-gori-exam-start.mp3",
    label: "გამოცდის დაწყება",
    description: "Simulatori.ge — სისტემა • გამოცდის დაწყება",
  },
  {
    phrase: "simulatori-gori/at-finish",
    fileName: "simulatori-gori-at-finish.mp3",
    label: "გამოცდის დასრულება",
    description: "Simulatori.ge — სისტემა • გამოცდის დასრულება",
  },

];

export const DEFAULT_STRAIGHT_RECORDED_PHRASE =
  "simulatori-gori/straight";
export const DEFAULT_LEFT_RECORDED_PHRASE =
  "simulatori-gori/turn-left-soon";
export const DEFAULT_RIGHT_RECORDED_PHRASE =
  "simulatori-gori/turn-right-soon";
export const EXAM_FINISH_RECORDED_PHRASE =
  "simulatori-gori/at-finish";

export function getRecordedCheckpointPrompt(phrase: string) {
  const wanted = phrase.trim();
  return RECORDED_CHECKPOINT_PROMPTS.find(
    (prompt) => prompt.phrase === wanted
  );
}
