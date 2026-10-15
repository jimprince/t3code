import {
  questionsComplete,
  sendableText,
  TYPED_ANSWER_MAX,
  type PlanOption,
  type PlanQuestion,
} from "@t3tools/client-runtime/decision-card";
import { SendIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { DecisionRow } from "./context";
import { useAnswerPlan, type DecisionAnswers } from "./useDecisionAnswers";

/** An option's text is "long" past this, and then takes a full row in a narrow column. */
const SHORT_OPTION_CHARS = 24;

const EFFECT_HINT = {
  settle: "Closes the task",
  start: "Starts the work; the task stays open",
} as const;

/** A long option takes its own row in a narrow column and sits inline in a wide one. */
const isLong = (text: string) => text.length > SHORT_OPTION_CHARS;

function OptionButton({
  text,
  hint,
  recommended,
  selected,
  onPick,
}: {
  readonly text: string;
  readonly hint?: string | undefined;
  readonly recommended: boolean;
  readonly selected?: boolean | undefined;
  readonly onPick: () => void;
}) {
  const filled = selected ?? recommended;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="sm-multiline"
            variant={filled ? "default" : "outline"}
            className={isLong(text) ? "w-full max-w-full @min-[52rem]/answer:w-auto" : "max-w-full"}
            aria-pressed={selected}
            onClick={onPick}
          />
        }
      >
        <span className="line-clamp-2 min-w-0 text-left break-words">{text}</span>
        {recommended ? (
          <span className="shrink-0 text-2xs font-normal opacity-70">recommended</span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup>{hint ? `${text}: ${hint}` : text}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The type-your-own box. Nothing is sent until Enter or Send: blur, navigation and a snapshot
 * refresh never send, and Esc clears the box (leaving Esc to the surrounding tray once empty).
 * An unsent draft survives a re-render through `draft`/`onDraft`.
 */
function AnswerBox({
  placeholder,
  initial,
  onDraft,
  onSend,
  inputRef,
}: {
  readonly placeholder: string;
  readonly initial: string;
  readonly onDraft: (text: string) => void;
  readonly onSend: (text: string) => void;
  readonly inputRef?: React.Ref<HTMLInputElement>;
}) {
  const [text, setText] = useState(initial);
  const sendable = sendableText(text);
  const send = () => {
    if (sendable === null) return;
    onSend(sendable);
    setText("");
    onDraft("");
  };
  return (
    <div className="flex items-center gap-1.5">
      <Input
        ref={inputRef}
        size="sm"
        value={text}
        maxLength={TYPED_ANSWER_MAX}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => {
          setText(event.target.value);
          onDraft(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            send();
          } else if (event.key === "Escape" && text !== "") {
            event.preventDefault();
            event.stopPropagation();
            setText("");
            onDraft("");
          }
        }}
      />
      <Button size="xs" variant="outline" disabled={sendable === null} onClick={send}>
        <SendIcon />
        Send
      </Button>
    </div>
  );
}

/** One thread question inside a multi-question ask: its options, then its own box. */
function QuestionRow({
  question,
  pick,
  onPick,
}: {
  readonly question: PlanQuestion;
  readonly pick: string | undefined;
  readonly onPick: (value: string) => void;
}) {
  const [typed, setTyped] = useState("");
  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs">
        <span className="font-medium">{question.header}</span>
        <span className="text-muted-foreground"> {question.question}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {question.options.map((option) => {
          const value = option.value ?? option.label;
          return (
            <OptionButton
              key={option.label}
              text={option.label}
              hint={option.description}
              recommended={false}
              selected={pick === value}
              onPick={() => {
                setTyped("");
                onPick(value);
              }}
            />
          );
        })}
      </div>
      {question.allowCustomAnswer === false ? null : (
        <Input
          size="sm"
          value={typed}
          maxLength={TYPED_ANSWER_MAX}
          placeholder="Your own answer"
          aria-label={`Your own answer to ${question.header}`}
          onChange={(event) => {
            setTyped(event.target.value);
            onPick(event.target.value);
          }}
        />
      )}
    </div>
  );
}

function Questions({
  row,
  answers,
  questions,
  compact,
}: {
  readonly row: DecisionRow;
  readonly answers: DecisionAnswers;
  readonly questions: ReadonlyArray<PlanQuestion>;
  readonly compact: boolean;
}) {
  const [picks, setPicks] = useState<Readonly<Record<string, string>>>({});
  const [typing, setTyping] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const single = questions.length === 1 ? questions[0]! : null;
  if (single) {
    return (
      <>
        <div className="flex flex-wrap gap-1.5">
          {single.options.map((option) => (
            <OptionButton
              key={option.label}
              text={option.label}
              hint={option.description}
              recommended={false}
              onPick={() =>
                answers.answerQuestions(row, questions, {
                  [single.id]: option.value ?? option.label,
                })
              }
            />
          ))}
        </div>
        {single.allowCustomAnswer === false ? null : compact && !typing ? (
          <div className="text-xs">
            <InlineButton
              tone="muted"
              onClick={() => {
                setTyping(true);
                queueMicrotask(() => ref.current?.focus());
              }}
            >
              Type your own
            </InlineButton>
          </div>
        ) : (
          <AnswerBox
            inputRef={ref}
            placeholder={`Your answer to ${row.attention.title}`}
            initial={answers.draftOf(row.key)}
            onDraft={(text) => answers.setDraft(row.key, text)}
            onSend={(text) => answers.answerQuestions(row, questions, { [single.id]: text })}
          />
        )}
      </>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {questions.map((question) => (
        <QuestionRow
          key={question.id}
          question={question}
          pick={picks[question.id]}
          onPick={(value) => setPicks((current) => ({ ...current, [question.id]: value }))}
        />
      ))}
      <div>
        <Button
          size="xs"
          variant="outline"
          disabled={!questionsComplete(questions, picks)}
          onClick={() => answers.answerQuestions(row, questions, picks)}
        >
          <SendIcon />
          Send answers
        </Button>
      </div>
    </div>
  );
}

/**
 * The one place a decision is answered, shared by the Dashboard rail, the project Dashboard, the
 * Chief of Staff tray strip and (in #356) the blocker popover: one-click options, a type-your-own
 * box that sends only on Enter or Send, and `children` (the muted Discuss / Open links) last. Every
 * answer goes through `answers`, so it is held with Undo, delivered by the same service as a click,
 * and confirmed on the card. `compact` (the tray) keeps the box behind "Type your own".
 */
export function DecisionAnswerArea({
  row,
  answers,
  compact = false,
  children,
}: {
  readonly row: DecisionRow;
  readonly answers: DecisionAnswers;
  readonly compact?: boolean;
  readonly children?: ReactNode;
}) {
  const plan = useAnswerPlan(row);
  const [typing, setTyping] = useState(() => answers.draftOf(row.key) !== "");
  const boxRef = useRef<HTMLInputElement>(null);
  const focusBox = () => {
    setTyping(true);
    queueMicrotask(() => boxRef.current?.focus());
  };

  const options: ReadonlyArray<PlanOption> =
    plan.mode === "issue" || plan.mode === "legacy-option" ? plan.options : [];
  const box =
    plan.mode === "issue" ? (
      compact && !typing ? (
        <div className="text-xs">
          <InlineButton tone="muted" onClick={focusBox}>
            Type your own
          </InlineButton>
        </div>
      ) : (
        <AnswerBox
          inputRef={boxRef}
          placeholder={plan.placeholder}
          initial={answers.draftOf(row.key)}
          onDraft={(text) => answers.setDraft(row.key, text)}
          onSend={(text) => answers.answerText(row, text)}
        />
      )
    ) : null;

  return (
    <div className="@container/answer mt-1 flex flex-col gap-1.5">
      {options.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {options.map((option) => (
            <OptionButton
              key={option.text}
              text={option.text}
              hint={option.effect ? EFFECT_HINT[option.effect] : undefined}
              recommended={option.recommended}
              onPick={() =>
                option.action === "follow-up" ? focusBox() : answers.answerOption(row, option)
              }
            />
          ))}
        </div>
      ) : null}
      {plan.mode === "approval" ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {plan.choices.map((choice, index) => (
            <Button
              key={choice.decision}
              size="xs"
              variant={index === 0 ? "default" : "outline"}
              title={choice.warning}
              onClick={() => answers.respond(row, choice.decision, choice.label)}
            >
              {choice.label}
            </Button>
          ))}
        </div>
      ) : null}
      {plan.mode === "questions" ? (
        <Questions row={row} answers={answers} questions={plan.questions} compact={compact} />
      ) : null}
      {box}
      {children ? (
        <div className="flex flex-wrap items-center gap-x-3 text-xs">{children}</div>
      ) : null}
    </div>
  );
}
