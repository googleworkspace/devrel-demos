/**
 * Hermetic Google Workspace Add-ons & Workspace Studio wire (JSON) schema types.
 * Embedded directly so this project is completely standalone with zero external path dependencies.
 */

export interface ActionParameter {
  key: string;
  value: string;
}

export interface Action {
  function: string;
  parameters?: ActionParameter[];
  loadIndicator?: 'SPINNER' | 'NONE';
  persistValues?: boolean;
}

export interface OpenLink {
  url: string;
  openAs?: 'FULL_SIZE' | 'OVERLAY';
  onClose?: 'NOTHING' | 'RELOAD';
}

export interface OnClick {
  action?: Action;
  openLink?: OpenLink;
  openDynamicLinkAction?: Action;
  card?: Card;
}

export interface Color {
  red?: number;
  green?: number;
  blue?: number;
  alpha?: number;
}

export interface Icon {
  knownIcon?: string;
  iconUrl?: string;
  altText?: string;
  imageType?: 'SQUARE' | 'CIRCLE';
  materialIcon?: {
    name: string;
    fill?: boolean;
    weight?: number;
    grade?: number;
    color?: Color;
  };
}

export interface Button {
  text?: string;
  altText?: string;
  icon?: Icon;
  color?: Color;
  onClick?: OnClick;
  disabled?: boolean;
  type?: 'OUTLINED' | 'FILLED';
}

export interface ButtonList {
  buttons: Button[];
}

export interface DecoratedText {
  icon?: Icon;
  startIcon?: Icon;
  topLabel?: string;
  text: string;
  wrapText?: boolean;
  bottomLabel?: string;
  onClick?: OnClick;
  button?: Button;
  switchControl?: {
    name: string;
    value?: string;
    selected?: boolean;
    onChangeAction?: Action;
    controlType?: 'SWITCH' | 'CHECKBOX' | 'CHECK_BOX';
  };
}

export interface TextParagraph {
  text: string;
  maxLines?: number;
  textSyntax?: 'MARKDOWN' | 'HTML';
}

export interface TextInput {
  name: string;
  label?: string;
  hintText?: string;
  value?: string;
  type?: 'SINGLE_LINE' | 'MULTIPLE_LINE';
  onChangeAction?: Action;
  placeholderText?: string;
  disabled?: boolean;
}

export interface SelectionItem {
  text: string;
  value: string;
  selected?: boolean;
  startIconUri?: string;
  bottomText?: string;
}

export interface SelectionInput {
  name: string;
  label?: string;
  type: 'CHECK_BOX' | 'RADIO_BUTTON' | 'SWITCH' | 'DROPDOWN' | 'MULTI_SELECT';
  items?: SelectionItem[];
  onChangeAction?: Action;
  disabled?: boolean;
}

export interface Widget {
  visibility?: 'VISIBLE' | 'HIDDEN';
  textParagraph?: TextParagraph;
  decoratedText?: DecoratedText;
  buttonList?: ButtonList;
  textInput?: TextInput;
  selectionInput?: SelectionInput;
  divider?: Record<string, never>;
}

export interface Section {
  id?: string;
  header?: string;
  widgets: Widget[];
  collapsible?: boolean;
  uncollapsibleWidgetsCount?: number;
}

export interface CardHeader {
  title: string;
  subtitle?: string;
  imageType?: 'SQUARE' | 'CIRCLE';
  imageUrl?: string;
  imageAltText?: string;
}

export interface Card {
  name?: string;
  header?: CardHeader;
  sections?: Section[];
}

export interface Navigation {
  pushCard?: Card;
  pop?: boolean;
  popToRoot?: boolean;
  popToCard?: string;
  updateCard?: Card;
}

export interface ModifyCard {
  insertSection?: {
    section: Section;
    belowSectionId?: string;
    onCardTop?: boolean;
  };
  removeSection?: {
    sectionId: string;
  };
  replaceSection?: Section;
  insertWidget?: {
    widget: Widget;
    belowWidgetId?: string;
    aboveWidgetId?: string;
  };
  removeWidget?: {
    widgetId: string;
  };
  replaceWidget?: Widget;
}

export interface ModifyOperation {
  insertSection?: {
    section: Section;
    belowSectionId?: string;
    onCardTop?: boolean;
  };
  removeSection?: {
    sectionId: string;
  };
  replaceSection?: Section;
  insertWidget?: {
    widget: Widget;
    belowWidgetId?: string;
    aboveWidgetId?: string;
  };
  removeWidget?: {
    widgetId: string;
  };
  replaceWidget?: Widget;
}

export interface VariableData {
  booleanValues?: boolean[];
  integerValues?: (number | string)[];
  floatValues?: number[];
  stringValues?: string[];
  timestampValues?: string[];
  resourceReferences?: string[];
  resourceDataValues?: {
    resourceId?: string;
    fields: Record<string, VariableData>;
  }[];
  emailAddressValues?: string[];
  users?: string[];
  textFormatValues?: unknown[];
}

export interface WorkflowChip {
  icon?: string;
  iconUrl?: string;
  materialIcon?: string;
  label?: string;
  url?: string;
}

export interface WorkflowStyledText {
  text: string;
  fontWeight?: 'LIGHT' | 'MEDIUM' | 'BOLD';
  color?: Color;
  styles?: ('ITALIC' | 'UNDERLINE' | 'STRIKETHROUGH' | 'UPPERCASE' | 'CODE' | 'CODE_BLOCK')[];
}

export interface WorkflowHyperlink {
  text: string;
  link: string;
}

export interface WorkflowListItem {
  textFormatElements: WorkflowTextFormatElement[];
}

export interface WorkflowListContainer {
  listType: 'ORDERED' | 'UNORDERED';
  listNestLevel?: number;
  listItems: WorkflowListItem[];
}

export type WorkflowTextFormatElement =
  | { text: string }
  | { chip: WorkflowChip }
  | { styledText: WorkflowStyledText }
  | { hyperlink: WorkflowHyperlink }
  | { listContainer: WorkflowListContainer };

export interface WorkflowTextFormatMarkup {
  textFormatElements: WorkflowTextFormatElement[];
}

export interface WorkflowAction {
  returnOutputVariablesAction?: {
    variables?: Record<string, VariableData>;
    log?: WorkflowTextFormatMarkup;
  };
  resourceRetrievedAction?: {
    resourceData?: {
      fields?: Record<string, VariableData>;
    };
  };
  returnElementErrorAction?: {
    developerErrorMessage?: string;
    errorLog?: WorkflowTextFormatMarkup;
    errorActionability?: 'ACTIONABLE' | 'NOT_ACTIONABLE';
    retryability?: 'RETRYABLE' | 'NOT_RETRYABLE';
  };
  saveWorkflowAction?: Record<string, never>;
  workflowValidationErrorAction?: {
    severity?: 'CRITICAL' | 'WARNING' | 'INFO';
  };
}

export interface HostAppActionMarkup {
  workflowAction?: WorkflowAction;
}

export interface StudioRenderActions {
  action?: {
    navigations?: Navigation[];
    link?: OpenLink;
    linkOpen?: OpenLink;
    notification?: { text: string };
    modifyCard?: ModifyCard;
    modifyOperations?: ModifyOperation[];
  };
  hostAppAction?: HostAppActionMarkup;
}

export interface AuthorizationEventObject {
  userOAuthToken?: string;
  userIdToken?: string;
  systemIdToken?: string;
  authorizedScopes?: string[];
}

export interface CommonEventObject {
  userLocale?: string;
  hostApp?: string;
  platform?: 'WEB' | 'IOS' | 'ANDROID';
  timeZone?: {
    id: string;
    offset?: number;
  };
  formInputs?: Record<
    string,
    {
      stringInputs?: { value: string[] };
      dateTimeInput?: { msSinceEpoch?: number; hasDate?: boolean; hasTime?: boolean };
       dateInput?: { msSinceEpoch?: number };
      timeInput?: { hours?: number; minutes?: number };
    }
  >;
  parameters?: Record<string, string>;
  invokedFunction?: string;
}

export interface ElementConfiguration {
  inputs?: Record<string, VariableData>;
}

export interface WorkflowTriggerCreation {
  triggerId: string;
  triggerType?: 'TRIGGER_TYPE_UNDEFINED' | 'REPEATING';
  inputs?: Record<string, VariableData>;
  notifyUri?: string;
}

export interface WorkflowTriggerDeletion {
  triggerId: string;
}

export interface WorkflowEventObject {
  actionInvocation?: {
    inputs?: Record<string, VariableData>;
  };
  elementConfiguration?: ElementConfiguration;
  triggerCreation?: WorkflowTriggerCreation;
  triggerDeletion?: WorkflowTriggerDeletion;
  triggerEventSource?:
    | 'TRIGGER_EVENT_SOURCE_UNSPECIFIED'
    | 'TRIGGER_EVENT_SOURCE_AUTOMATED'
    | 'TRIGGER_EVENT_SOURCE_TEST_RUN';
}

export interface RootEventObject {
  commonEventObject?: CommonEventObject;
  authorizationEventObject?: AuthorizationEventObject;
  workflow?: WorkflowEventObject;
}

export interface FireTriggerRequest {
  name?: string;
  outputs?: Record<string, VariableData>;
  log?: WorkflowTextFormatMarkup;
  requestId?: string;
}
