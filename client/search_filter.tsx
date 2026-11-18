// The filter panel on the search page: where to search (everywhere, some
// forums, or one topic) and whose posts. gulpfile.ts#bundleSearch bundles it
// with React into one file that views/search_results.html loads from the
// forum, so the page runs no code from another site and compiles no JSX in the
// browser. The field names are the query server/routes/search.ts reads.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";

// The page supplies these globals: all.js loads jQuery on every page, and
// views/search_results.html loads typeahead.bundle.js (typeahead 0.10) first.
type TypeaheadInput = { typeahead(...args: unknown[]): unknown };
declare const $: (el: Element) => TypeaheadInput;
declare const Bloodhound: {
  new (options: object): { initialize(): void; ttAdapter(): unknown };
  tokenizers: {
    whitespace: unknown;
    obj: { whitespace(key: string): unknown };
  };
};

// What the route offers: only forums the viewer may read, id and title only.
type ForumChoice = {
  id: number;
  title: string;
  forums: Array<{ id: number; title: string }>;
};

type LocationProps = {
  forumChoices: ForumChoice[];
  topicId?: number;
  forumIds?: number[];
};

type Tab = "everywhere" | "forum" | "topic";

const TABS: Array<[Tab, string]> = [
  ["everywhere", "Everywhere"],
  ["forum", "Specific Forums"],
  ["topic", "Topic"],
];

// Only the open tab renders its fields, so the form sends topic_id or
// forum_ids only from that tab. Each tab keeps its value while another is
// open.
function LocationFilter({ forumChoices, topicId, forumIds }: LocationProps) {
  const [tab, setTab] = useState<Tab>(
    topicId ? "topic" : forumIds ? "forum" : "everywhere",
  );
  const [topic, setTopic] = useState(topicId ? String(topicId) : "");
  const [forums, setForums] = useState((forumIds ?? []).map(String));

  let content;
  if (tab === "topic") {
    content = (
      <div>
        <p className="text-muted">Search in a single topic.</p>
        Topic ID:{" "}
        <input
          type="text"
          name="topic_id"
          className="form-control"
          style={{ width: "200px", display: "inline-block" }}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
        />
      </div>
    );
  } else if (tab === "forum") {
    content = (
      <div>
        <p className="text-muted">Search in specific forums.</p>
        <p className="multi-select-hint text-muted">
          Desktop users: Hold down the <code>cmd</code> (Mac) or{" "}
          <code>ctrl</code> (Windows) key to select multiple forums.
        </p>
        <select
          multiple
          name="forum_ids"
          className="form-control"
          style={{ height: "200px" }}
          value={forums}
          onChange={(e) =>
            setForums(Array.from(e.target.selectedOptions, (o) => o.value))
          }
        >
          {forumChoices.map((c) => (
            <optgroup label={c.title} key={c.id}>
              {c.forums.map((f) => (
                <option style={{ paddingLeft: "15px" }} value={f.id} key={f.id}>
                  &mdash; {f.title}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
    );
  } else {
    content = <p className="text-muted">Search in all forums</p>;
  }

  return (
    <div className="panel panel-default">
      <div className="panel-heading">Where to search:</div>
      <div className="panel-body">
        <ul className="nav nav-tabs">
          {TABS.map(([name, title]) => (
            <li key={name} className={tab === name ? "active" : ""}>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setTab(name);
                }}
              >
                {title}
              </a>
            </li>
          ))}
        </ul>
        <div style={{ padding: "20px", marginBottom: "20px" }}>{content}</div>
      </div>
    </div>
  );
}

// Each name rides along as a hidden unames field.
function UnameFilter({ initial }: { initial: string[] }) {
  const [unames, setUnames] = useState(initial);

  function add(uname: string) {
    setUnames((list) => (list.includes(uname) ? list : [...list, uname]));
  }

  function remove(uname: string) {
    setUnames((list) => list.filter((u) => u !== uname));
  }

  return (
    <ul>
      {unames.map((uname) => (
        <li key={uname}>
          <button
            type="button"
            className="btn btn-danger btn-xs"
            onClick={() => remove(uname)}
          >
            &times;
          </button>
          <input type="hidden" name="unames" value={uname} />
          {uname}
        </li>
      ))}
      <NewUname onAdd={add} />
    </ul>
  );
}

// The input is uncontrolled: the typeahead writes the chosen name into it
// without a change event, so adding reads the input itself.
function NewUname({ onAdd }: { onAdd: (uname: string) => void }) {
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = input.current!;
    const names = new Bloodhound({
      datumTokenizer: Bloodhound.tokenizers.obj.whitespace("value"),
      queryTokenizer: Bloodhound.tokenizers.whitespace,
      limit: 5,
      prefetch: {
        cacheKey: "unames",
        url: "/unames.json",
        filter: (unames: string[]) => unames.map((value) => ({ value })),
      },
    });
    names.initialize();
    $(el).typeahead(
      { hint: true, highlight: true, minLength: 1 },
      { name: "Usernames", displayKey: "value", source: names.ttAdapter() },
    );
    return () => {
      $(el).typeahead("destroy");
    };
  }, []);

  function add() {
    const el = input.current!;
    const uname = el.value.trim();
    if (uname.length === 0) return;
    onAdd(uname);
    $(el).typeahead("val", "");
    el.focus();
  }

  // Enter adds the name instead of sending the form. The typeahead's own
  // keydown handler runs first, so a highlighted suggestion is already in the
  // input.
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    add();
    $(input.current!).typeahead("close");
  }

  return (
    <li>
      <input
        type="text"
        className="form-control new-uname-input"
        style={{ display: "inline-block", width: "200px" }}
        ref={input}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className="btn btn-default new-uname-btn"
        onClick={add}
      >
        Add
      </button>
    </li>
  );
}

// The view prints the location props as JSON in data-props, escaped by
// nunjucks. The names come from the hidden fields the view renders, which
// also carry them when this file does not load.
const locationEl = document.getElementById("location-filter");
if (locationEl) {
  const props = JSON.parse(locationEl.dataset["props"] ?? "") as LocationProps;
  createRoot(locationEl).render(<LocationFilter {...props} />);
}

const unamesEl = document.getElementById("filter-unames-list-hardpoint");
if (unamesEl) {
  const initial = Array.from(
    unamesEl.querySelectorAll<HTMLInputElement>('input[name="unames"]'),
    (el) => el.value,
  );
  createRoot(unamesEl).render(<UnameFilter initial={initial} />);
}
