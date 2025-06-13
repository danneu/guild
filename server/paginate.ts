"use strict";
// 3rd
import _ from "lodash";
// 1st
import * as config from "./config";

type PaginatorItem =
  | { kind: "SEPARATOR" }
  | {
      text: string;
      href: string;
      kind: "BUTTON";
      isActive?: boolean;
    };

// perPage is optional override, defaults to config
//
// Returns falsey if no paginator needs to be displayed
export const makeFullPaginator = function (
  currPage: number,
  totalItems: number,
  perPage: number = config.CONVOS_PER_PAGE,
) {
  const totalPages = Math.max(1, Math.ceil(totalItems / perPage));
  currPage = Math.min(currPage, totalPages);

  if (currPage === 1 && totalPages === 1) {
    return null;
  }

  let innerItems: PaginatorItem[] = [];
  let startPgNum = Math.max(1, currPage - 3);
  let endPgNum = Math.min(totalPages, startPgNum + 6);

  if (currPage > 1) {
    innerItems.push({
      text: "Prev",
      href: `?page=${currPage - 1}`,
      kind: "BUTTON",
    });
  }

  if (startPgNum > 1) {
    innerItems.push({ text: "1", href: `?page=1`, kind: "BUTTON" });
  }

  if (startPgNum > 2) {
    innerItems.push({ kind: "SEPARATOR" });
  }

  _.range(startPgNum, endPgNum + 1).forEach((n) => {
    const btn: PaginatorItem = {
      text: n.toString(),
      href: `?page=${n}`,
      isActive: n === currPage,
      kind: "BUTTON",
    };
    innerItems.push(btn);
  });

  if (endPgNum < totalPages - 1) {
    innerItems.push({ kind: "SEPARATOR" });
  }

  if (endPgNum < totalPages) {
    innerItems.push({
      text: totalPages.toString(),
      href: `?page=${totalPages.toString()}`,
      kind: "BUTTON",
    });
  }

  if (currPage < totalPages) {
    innerItems.push({
      text: "Next",
      href: `?page=${currPage + 1}`,
      kind: "BUTTON",
    });
  }

  return innerItems;
};
