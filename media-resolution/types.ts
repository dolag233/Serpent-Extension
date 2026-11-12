export type MediaKind = 'image' | 'video';

export type MediaCandidateSource =
  | 'site-field'
  | 'srcset'
  | 'known-transform'
  | 'structured-data'
  | 'page-bridge'
  | 'preview';

export interface MediaCandidate {
  readonly url: string;
  readonly kind: MediaKind;
  readonly source: MediaCandidateSource;
  readonly contentId?: string;
  readonly mediaKey?: string;
  readonly mediaIndex?: number;
  readonly width?: number;
  readonly height?: number;
}

export type SiteAdapterId =
  | 'baidu-images'
  | 'bing-images'
  | 'google-images'
  | 'sogou-images'
  | '360-images'
  | 'yandex-images'
  | 'duckduckgo-images'
  | 'pinterest'
  | 'huaban'
  | 'behance'
  | 'zcool'
  | 'dribbble'
  | 'artstation'
  | 'xiaohongshu'
  | 'instagram'
  | 'weibo'
  | 'pixiv'
  | 'x';

export type SiteAdapterCapability =
  | 'local-fields'
  | 'verified-url-pattern'
  | 'page-bridge'
  | 'preview-only-unverified';

export interface MediaSelection {
  readonly selectionId: string;
  readonly documentId: string;
  /** Added by the extension background from the browser message sender. */
  readonly frameId?: number;
  readonly kind: MediaKind;
  readonly previewUrl: string;
  readonly pageUrl: string;
  readonly detailPageUrl?: string;
  /** Pinterest video poster used only to locate the selected carousel slot. */
  readonly posterUrl?: string;
  readonly contentId?: string;
  readonly mediaKey?: string;
  readonly mediaIndex?: number;
  readonly previewWidth?: number;
  readonly previewHeight?: number;
  readonly siteAdapter?: SiteAdapterId;
  readonly siteCapability?: SiteAdapterCapability;
  readonly candidates: readonly MediaCandidate[];
  readonly evidence?: {
    readonly tagName: string;
    readonly anchorUrl?: string;
    readonly attributes?: Readonly<Record<string, string>>;
  };
}
