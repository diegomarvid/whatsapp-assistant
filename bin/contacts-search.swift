import Contacts
import Foundation

struct ContactMatch: Encodable {
  let name: String
  let phones: [String]
  let score: Int
}

func normalized(_ value: String) -> String {
  value.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: .current)
    .components(separatedBy: CharacterSet.alphanumerics.inverted)
    .joined()
}

func tokens(_ value: String) -> [String] {
  value.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: .current)
    .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
    .map(String.init)
}

func digits(_ value: String) -> String {
  value.filter(\.isNumber)
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard let mode = arguments.first else { exit(0) }
let phoneLookup = mode == "--phones"
let query = phoneLookup ? "" : mode
let requestedPhones = Set(phoneLookup ? arguments.dropFirst().map(digits).filter { !$0.isEmpty } : [])
let queryTokens = tokens(query)
let queryNormalized = normalized(query)
let store = CNContactStore()
let keys: [CNKeyDescriptor] = [
  CNContactGivenNameKey as CNKeyDescriptor,
  CNContactFamilyNameKey as CNKeyDescriptor,
  CNContactOrganizationNameKey as CNKeyDescriptor,
  CNContactPhoneNumbersKey as CNKeyDescriptor,
]
let request = CNContactFetchRequest(keysToFetch: keys)
var matches: [ContactMatch] = []

try store.enumerateContacts(with: request) { contact, _ in
  let name = [contact.givenName, contact.familyName].filter { !$0.isEmpty }.joined(separator: " ")
  let displayName = name.isEmpty ? contact.organizationName : name
  guard !displayName.isEmpty else { return }
  let phones = contact.phoneNumbers.map { $0.value.stringValue }
  let normalizedPhones = phones.map(digits)

  if phoneLookup {
    guard normalizedPhones.contains(where: requestedPhones.contains) else { return }
    matches.append(ContactMatch(name: displayName, phones: phones, score: 1000))
    return
  }

  let nameTokens = tokens(displayName)
  let nameNormalized = normalized(displayName)
  let score: Int
  if nameNormalized == queryNormalized {
    score = 1000
  } else if !queryTokens.isEmpty && queryTokens.allSatisfy({ queryToken in
    nameTokens.contains(where: { $0.hasPrefix(queryToken) })
  }) {
    score = 700 + queryTokens.reduce(0) { $0 + $1.count }
  } else if nameNormalized.contains(queryNormalized) {
    score = 500 + queryNormalized.count
  } else {
    return
  }
  matches.append(ContactMatch(name: displayName, phones: phones, score: score))
}

let output = matches.sorted { left, right in
  left.score == right.score ? left.name.localizedCaseInsensitiveCompare(right.name) == .orderedAscending : left.score > right.score
}
let data = try JSONEncoder().encode(output)
print(String(decoding: data, as: UTF8.self))
