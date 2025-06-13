// http://stackoverflow.com/questions/3898083/find-longest-repeating-substring-in-javascript-using-regular-expressions
function longestRepeatingSubstring(input: string): string {
  const reg = /(?=((.+)(?:.*?\2)+))/g;
  let sub: RegExpExecArray | null = null; //somewhere to stick temp results
  let maxstr = ""; // our maximum length repeated string
  reg.lastIndex = 0; // because reg previously existed, we may need to reset this
  sub = reg.exec(input); // find the first repeated string
  while (!(sub == null)) {
    if (sub !== null && sub[2] !== undefined && sub[2].length > maxstr.length) {
      maxstr = sub[2]!;
    }
    sub = reg.exec(input);
    reg.lastIndex++; // start searching from the next position
  }
  return maxstr;
}

// Returns the number of times substring appears in fullstring
function countSubstringOccurrences(substring, fullstring) {
  const count = (fullstring.match(new RegExp(substring, "g")) || []).length;
  return count;
}

// Returns { longest: String, count: Int, isSpam: Boolean }
function analyze(fullstring) {
  const longest = longestRepeatingSubstring(fullstring);
  const length = longest.length;
  const count = countSubstringOccurrences(longest, fullstring);

  if (longest.length < 20) {
    return { longest, length, count, isSpam: false };
  }

  if (count < 3) {
    return { longest, length, count, isSpam: false };
  }

  return { longest, length, count, isSpam: true };
}

export default { analyze };
