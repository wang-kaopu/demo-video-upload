export type DouyinVisibility = "friends" | "public" | "self";

export interface PublishText {
  description: string;
  title: string;
}

export interface PublishTopic {
  id: string;
  name: string;
}

export interface BuildPublishPayloadInput {
  coverHeight: number;
  coverUri: string;
  coverUrl: string;
  coverWidth: number;
  description: string;
  now?: number;
  topics: PublishTopic[];
  title: string;
  videoId: string;
  visibility: DouyinVisibility;
}

export type QueryParams = Record<string, string | number | boolean | null | undefined>;

const VISIBILITY_VALUES: Record<DouyinVisibility, 0 | 1 | 2> = {
  friends: 2,
  public: 0,
  self: 1,
};

/**
 * 将命令行可见性名称转换为 create_v2 使用的数字枚举。
 *
 * @param visibility - self、friends 或 public
 * @returns 抖音发布接口可见性枚举
 */
export function getVisibilityValue(visibility: DouyinVisibility): 0 | 1 | 2 {
  return VISIBILITY_VALUES[visibility];
}

/**
 * 校验并解析命令行可见性。
 *
 * @param value - 命令行原始值；缺省时仅自己可见
 * @returns 经过校验的可见性
 */
export function parseVisibility(value: string | undefined): DouyinVisibility {
  const visibility = value ?? "self";
  if (visibility === "self" || visibility === "friends" || visibility === "public") {
    return visibility;
  }
  throw new Error("--visibility 只支持 self、friends 或 public");
}

/**
 * 将 Demo 文案拆成首行标题和后续描述。
 *
 * @param text - UTF-8 文案全文
 * @returns 发布标题与描述
 */
export function parsePublishText(text: string): PublishText {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const firstNonEmptyIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstNonEmptyIndex < 0) {
    throw new Error("文案至少需要一行非空标题");
  }

  const title = lines[firstNonEmptyIndex]?.trim() ?? "";
  if ([...title].length > 20) {
    throw new Error("文案首行标题不能超过 20 个字符");
  }

  return {
    description: lines.slice(firstNonEmptyIndex + 1).join("\n").trim(),
    title,
  };
}

/**
 * 按插入顺序序列化普通 Creator Query，每个值只编码一次。
 *
 * @param params - Query 参数
 * @returns 稳定的查询字符串
 */
export function serializeQuery(params: QueryParams): string {
  return Object.entries(params)
    .filter((entry): entry is [string, string | number | boolean] =>
      entry[1] !== null && entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

/**
 * 删除已经转换成结构化话题的 hashtag，未匹配话题保留原文。
 *
 * @param description - 原始描述
 * @param topics - 搜索成功的话题
 * @returns 移除已匹配 hashtag 后的描述
 */
export function removeMatchedHashtags(description: string, topics: PublishTopic[]): string {
  const matched = new Set(topics.map(({ name }) => name));
  return description
    .replace(/#([^#\s]+)(?=\s|#|$)/gu, (full, name: string) => matched.has(name) ? "" : full)
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/^[ \t]+|[ \t]+$/gmu, "")
    .trim();
}

/**
 * 构造原包双封面编辑日志。
 *
 * @returns create_v2 cover_tools_info 使用的编辑日志
 */
function buildCoverEditLog(): Record<string, unknown> {
  return {
    video_cover_source: "pic_adjust",
    cover_timestamp: 0,
    recommend_timestamp: "0",
    is_cover_edit: "true",
    is_cover_template: 0,
    cover_template_id: "",
    is_text_template: 0,
    text_template_id: "",
    text_template_content: "",
    is_text: 0,
    text_num: 0,
    text_content: "",
    is_use_sticker: 0,
    sticker_id: "",
    sticker_tab_name: "",
    is_use_filter: 0,
    filter_id: "",
    cover_tab_name: "",
    filter_tab_name: "",
    is_cover_modify: 0,
    to_status: "portrait",
    tab_name: "",
    is_setting_double_cover: 1,
    second_cover_details: JSON.stringify({
      video_cover_source_landscape: "pic_adjust",
      cover_timestamp_landscape: 0,
      recommend_timestamp_landscape: "0",
      is_cover_edit_landscape: true,
      is_cover_template_landscape: 0,
      cover_template_id_landscape: "",
      is_text_template_landscape: 0,
      text_template_id_landscape: "",
      text_template_content_landscape: "",
      is_text_landscape: 0,
      text_num_landscape: 0,
      text_content_landscape: "",
      is_use_sticker_landscape: 0,
      sticker_id_landscape: "",
      sticker_tab_name_landscape: "",
      is_use_filter_landscape: 0,
      filter_id_landscape: "",
      cover_tab_name_landscape: "",
      filter_tab_name_landscape: "",
      is_cover_modify_landscape: 0,
      to_status_landscape: "portrait",
      tab_name_landscape: "",
    }),
  };
}

/**
 * 构造 create_v2 使用的完整封面编辑扩展信息。
 *
 * @param input - 封面 URI、URL 和尺寸
 * @returns JSON 字符串形式的封面扩展信息
 */
function buildCoverToolsExtendInfo(input: {
  height: number;
  uri: string;
  url: string;
  width: number;
}): string {
  const editLog = buildCoverEditLog();
  const coverInfo = {
    videoName: "",
    verticalLocalEditorCoverData: 1,
    horizontalLocalEditorCoverData: 1,
    coverEditLogInfo: editLog,
    posterDelay: 0,
    uri: input.uri,
    customCoverImageHeight: input.height,
    customCoverImageWidth: input.width,
    edited: true,
    coverText: "",
    type: 2,
    defaultUri: input.uri,
    horizontalDefaultUri: input.uri,
    cropedUri: input.uri,
    aiGenCoverId: "",
    url: input.url,
  };

  return JSON.stringify({
    recommendServerInfo: { res: [], times: [] },
    recommendCoverList: [],
    recommendCoverInfo: {
      isFromRecommend: true,
      isDefaultSelect: false,
      isRecommendClickFrom: "",
      selectInfo: {},
      editingInfo: {},
    },
    recommendCoverTime: 0,
    coverInfo,
    coverUrl: input.url,
    coverHorizontalInfo: {
      ...coverInfo,
      horizontalDefaultUri: undefined,
    },
    coverHorizontalUrl: input.url,
    pasterInfo: {},
    stateInfo: null,
    croppedCoverInfo: null,
    uploadBackgroundInfo: null,
    uploadPasterInfo: null,
    uploadCoverStateInfo: null,
    xiguaCoverInfo: { posterDelay: 0 },
    xiguaPasterInfo: null,
    xiguaStateInfo: null,
    xiguaUploadCoverStateInfo: null,
    xiguaUploadBackgroundInfo: null,
    xiguaUploadPasterInfo: null,
    editXigua: false,
    coverSource: "",
    previewVideoList: [{ isCurrent: true }],
  });
}

/**
 * 构造 create_v2 使用的封面工具摘要。
 *
 * @param input - 封面 URI 和尺寸
 * @returns JSON 字符串形式的工具摘要
 */
function buildCoverToolsInfo(input: { height: number; uri: string; width: number }): string {
  return JSON.stringify({
    video_cover_source: "pic_adjust",
    cover_timestamp: 0,
    recommend_timestamp: "{0}",
    is_cover_edit: true,
    is_cover_template: 0,
    is_text_template: 0,
    is_text: 0,
    text_num: 0,
    text_content: "",
    text_template_content: "",
    is_use_sticker: 0,
    sticker_id: "",
    sticker_tab_name: "",
    is_use_filter: 0,
    filter_id: "",
    cover_template_id: "",
    cover_tab_name: "",
    filter_tab_name: "",
    tab_name: "",
    is_cover_modify: 0,
    to_status: "portrait",
    is_use_cover_edit: 1,
    cover_type: 1,
    initial_cover_uri: input.uri,
    cut_coordinate: "[0.0000,0.0000,1.0000,1.0000]",
    cover_width: input.width,
    cover_height: input.height,
  });
}

/**
 * 构造抖音 create_v2 的完整发布 Payload。
 *
 * @param input - 视频、封面、文案、话题和可见性
 * @returns 保持原包字段插入顺序的发布对象
 */
export function buildPublishPayload(input: BuildPublishPayloadInput): Record<string, unknown> {
  const now = input.now ?? Date.now();
  const description = removeMatchedHashtags(input.description, input.topics);
  let text = input.title ? `${input.title} ` : "";
  let cursor = text.length;
  text += description;
  cursor += description.length;
  const textExtra: Array<Record<string, unknown>> = [];
  const challenges: number[] = [];

  for (const topic of input.topics) {
    const start = cursor + 1;
    const end = start + topic.name.length + 1;
    const id = Number(topic.id);
    textExtra.push({
      start,
      end,
      type: 1,
      hashtag_name: topic.name,
      hashtag_id: id,
      user_id: "",
      caption_start: start,
      caption_end: end,
    });
    text += ` #${topic.name}`;
    cursor = end;
    if (Number.isFinite(id) && id > 0) {
      challenges.push(id);
    }
  }

  const chapter = {
    chapter_abstract: "",
    chapter_details: [],
    chapter_type: 0,
    chapter_tools_info: {
      chapter_recommend_detail: [],
      chapter_recommend_abstract: "",
      chapter_source: 2,
      chapter_recommend_type: -2,
      create_date: Math.floor(now / 1_000),
      is_pc: "1",
      is_pre_generated: "0",
      is_syn: "1",
    },
  };

  return {
    item: {
      common: {
        text,
        caption: input.title ? text.slice(input.title.length) : text,
        item_title: input.title,
        activity: "[]",
        text_extra: JSON.stringify(textExtra),
        challenges: JSON.stringify(challenges),
        mentions: "[]",
        hashtag_source: "",
        hot_sentence: "",
        interaction_stickers: "[]",
        visibility_type: getVisibilityValue(input.visibility),
        download: 1,
        timing: 0,
        creation_id: Math.random().toString(36).slice(-8) + now,
        media_type: 4,
        video_id: input.videoId,
        music_source: 0,
        music_id: null,
      },
      cover: {
        poster: input.coverUri,
        poster_delay: 0,
        custom_cover_image_height: input.coverHeight,
        custom_cover_image_width: input.coverWidth,
        cover_tools_extend_info: buildCoverToolsExtendInfo({
          height: input.coverHeight,
          uri: input.coverUri,
          url: input.coverUrl,
          width: input.coverWidth,
        }),
        cover_tools_info: buildCoverToolsInfo({
          height: input.coverHeight,
          uri: input.coverUri,
          width: input.coverWidth,
        }),
        horizontal_custom_cover_image_uri: input.coverUri,
        horizontal_cover_tsp: 0,
        horizontal_custom_cover_image_height: input.coverHeight,
        horizontal_custom_cover_image_width: input.coverWidth,
      },
      mix: {},
      selected_member: { is_selected_member_video: false },
      chapter: { chapter: JSON.stringify(chapter) },
      anchor: {},
      sync: {
        dx_upgraded: 1,
        xg_user_id: "",
        should_sync: false,
        sync_to_toutiao: 0,
      },
      open_platform: {},
      aigc: { meta: "{}", ContentPropagator: "", PropagateID: "", ReservedCode2: "{}" },
      assistant: { is_preview: 0, is_post_assistant: 1 },
      declare: { user_declare_info: "{}" },
    },
  };
}
